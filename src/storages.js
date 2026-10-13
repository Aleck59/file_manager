// Несколько S3-хранилищ как единый диск.
//
// - Структура папок общая: папка «Документы/» существует сразу во всех хранилищах,
//   её содержимое — объединение содержимого во всех бакетах.
// - Каждый файл физически лежит в одном хранилище; в API он адресуется ссылкой
//   «<id хранилища>:<ключ>». Переименование и перемещение — внутри своего бакета.
// - Куда попадает новый файл, решает политика размещения: «по порядку» (заполнять
//   хранилища по очереди с учётом квот) или «балансировка» (в наименее занятое).
// - Недоступное хранилище не ломает диск: его файлы временно не видны, а клиент
//   получает предупреждение.
import { config, onConfigChange } from './config.js';
import { recordUsage } from './usage-history.js';
import { categoryOf, compareKeys, folderFromKey, formatRef, isValidKey, nameFromKey, parseRef } from './keys.js';
import { describeS3Error, Storage } from './s3.js';

const GB = 1024 ** 3;

export class StorageNotConfigured extends Error {
  constructor() {
    super('Хранилище S3 не настроено. Администратор может добавить его в разделе «Настройки».');
    this.status = 503;
    this.code = 'S3_NOT_CONFIGURED';
  }
}

// ---------- реестр ----------
let instances = new Map(); // id -> Storage

// Состояние хранилищ: когда последний раз не ответило. Недавно упавшее хранилище
// не получает новые файлы (иначе загрузка упала бы уже в браузере).
const DOWN_FOR = 60_000;
const failures = new Map(); // id -> { at, error }
export function markFailed(id, err) {
  failures.set(id, { at: Date.now(), error: describeS3Error(err) });
  lastProbe.set(id, Date.now());
}
export function markOk(id) {
  failures.delete(id);
  lastProbe.delete(id);
}
const recentlyFailed = (id) => {
  const f = failures.get(id);
  return f && Date.now() - f.at < DOWN_FOR ? f : null;
};

// Пока хранилище недоступно, чтение (списки, статистика) его пропускает сразу, а не ждёт
// таймаут соединения в каждом запросе; повторная проверка — не чаще раза в RETRY_EVERY.
const RETRY_EVERY = 30_000;
const lastProbe = new Map(); // id -> время последней попытки, пока хранилище «лежит»
function skipWhileDown(st) {
  const f = recentlyFailed(st.id);
  if (!f) return null;
  const probed = lastProbe.get(st.id) ?? 0;
  if (Date.now() - probed >= RETRY_EVERY) {
    lastProbe.set(st.id, Date.now());
    return null; // пора проверить снова
  }
  return Object.assign(new Error(f.error), { name: 'StorageDown', skipped: true });
}

function sync() {
  const next = new Map();
  for (const def of config.storages) {
    const prev = instances.get(def.id);
    // Клиент пересоздаётся, только если изменились параметры этого хранилища.
    if (prev && JSON.stringify(prev.def) === JSON.stringify(def)) next.set(def.id, prev);
    else next.set(def.id, new Storage(def));
  }
  for (const [id, st] of instances) if (next.get(id) !== st) st.destroy();
  instances = next;
}
sync();
onConfigChange((changed) => {
  if (changed.includes('STORAGES')) {
    sync();
    invalidateStats();
    lastStats = null;
    reserved.clear();
  }
});

/** Все хранилища в порядке из настроек. */
export function all() {
  if (!instances.size) throw new StorageNotConfigured();
  return [...instances.values()];
}

export function get(id) {
  const st = instances.get(id);
  if (!st) throw Object.assign(new Error('Хранилище файла не найдено — возможно, его отключили в настройках'), { status: 404 });
  return st;
}

/** Ссылка из API → { st, rel }. Бросает 400 при некорректной ссылке. */
export function resolveRef(ref) {
  const parsed = parseRef(ref);
  if (!parsed) throw Object.assign(new Error('Некорректный ключ файла'), { status: 400 });
  return { st: get(parsed.storageId), rel: parsed.rel };
}

export const fileInfo = (st, rel, size, lastModified) => ({
  key: formatRef(st.id, rel),
  name: nameFromKey(rel),
  size,
  lastModified: lastModified instanceof Date ? lastModified.toISOString() : lastModified ?? new Date().toISOString(),
  storage: st.id,
});

/** Выполняет операцию во всех хранилищах; ошибки отдельных — в warnings. Все упали — бросает. */
async function everywhere(fn) {
  const list = all();
  const results = await Promise.allSettled(list.map((st) => fn(st)));
  const warnings = [];
  const values = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      values.push(r.value);
      markOk(list[i].id);
    } else {
      markFailed(list[i].id, r.reason);
      warnings.push({ storage: list[i].name, error: describeS3Error(r.reason) });
    }
  });
  if (!values.length) throw results[0].reason;
  return { values, warnings };
}

// ---------- объединённый список папки ----------

/**
 * Слияние страниц разных хранилищ в одну. Ключи у всех хранилищ одного формата и
 * сортируются одинаково (как в S3 — по байтам), поэтому первые `limit` элементов
 * объединения гарантированно есть среди первых `limit` каждого хранилища, и курсором
 * служит просто последний выданный ключ (ListObjectsV2 StartAfter).
 * @param {{st: {id}, page: {folders, files, truncated}}[]} pages
 */
export function mergePages(pages, { cursor, limit }) {
  const entries = [];
  for (const { st, page } of pages) {
    for (const path of page.folders) entries.push({ k: path, folder: path });
    for (const f of page.files) entries.push({ k: f.rel, file: { ...f, st } });
  }
  entries.sort((a, b) => compareKeys(a.k, b.k));

  const folders = [];
  const files = [];
  const seenFolders = new Set();
  let last = null;
  let taken = 0;
  for (const e of entries) {
    // Подпапка, совпадающая с курсором, могла прийти повторно (StartAfter="a/" снова
    // сворачивает "a/…" в "a/") — пропускаем; одинаковые папки разных хранилищ — одна.
    if (cursor && compareKeys(e.k, cursor) <= 0) continue;
    if (e.folder && seenFolders.has(e.folder)) continue;
    if (taken === limit) {
      return { folders, files, nextCursor: last };
    }
    taken++;
    last = e.k;
    if (e.folder) {
      seenFolders.add(e.folder);
      folders.push({ path: e.folder, name: e.folder.slice(0, -1).split('/').pop() });
    } else {
      files.push(e.file);
    }
  }
  const more = pages.some(({ page }) => page.truncated);
  return { folders, files, nextCursor: more && last ? last : null };
}

export async function listFolder(folder, { cursor, limit = 200 } = {}) {
  const list = all();
  const results = await Promise.allSettled(list.map((st) => {
    const down = skipWhileDown(st);
    return down ? Promise.reject(down) : st.listPage(folder, { startAfter: cursor, limit });
  }));
  const pages = [];
  const warnings = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      pages.push({ st: list[i], page: r.value });
      markOk(list[i].id);
    } else {
      if (!r.reason?.skipped) {
        markFailed(list[i].id, r.reason);
        console.error(`[storage ${list[i].name}] список не получен:`, r.reason?.name, r.reason?.message);
      }
      warnings.push({ storage: list[i].name, error: r.reason?.skipped ? r.reason.message : describeS3Error(r.reason) });
    }
  });
  if (!pages.length) throw results[0].reason;
  const merged = mergePages(pages, { cursor, limit });
  return {
    folders: merged.folders,
    files: merged.files.map((f) => fileInfo(f.st, f.rel, f.size, f.lastModified)),
    nextCursor: merged.nextCursor,
    warnings,
  };
}

// ---------- папки во всех хранилищах ----------

export async function createFolder(path) {
  return everywhere((st) => st.putFolderMarker(path));
}

export async function deleteFolder(path) {
  const { values, warnings } = await everywhere((st) => st.deleteFolder(path));
  return { deleted: values.reduce((a, b) => a + b, 0), warnings };
}

// ---------- статистика (кэш на 30 с, сбрасывается после изменений) ----------
const STATS_TTL = 30_000;
const STATS_MAX_OBJECTS = 20_000; // на одно хранилище
let statsCache = null; // для страницы статистики: сбрасывается после изменений
let lastStats = null; // последний подсчёт вообще — для выбора хранилища при загрузке
let statsGeneration = 0;
let pendingStats = null;

// Сбрасывается ПОСЛЕ успешного изменения в S3. Счётчик поколений не даёт сохранить в кэш
// результат подсчёта, который начался до изменения и закончился после.
export function invalidateStats() {
  statsCache = null;
  statsGeneration++;
}

// ISO-даты сравниваются как строки — без localeCompare (он подгружает ICU, ~5 МБ).
const byDateDesc = (a, b) => ((b.lastModified ?? '') > (a.lastModified ?? '') ? 1 : -1);
const parentFolders = (folder) => {
  const out = [];
  for (let f = folder; f; f = f.slice(0, f.slice(0, -1).lastIndexOf('/') + 1)) out.push(f);
  return out;
};

async function computeStats() {
  const categories = Object.fromEntries(
    ['image', 'video', 'audio', 'document', 'archive', 'other'].map((c) => [c, { count: 0, size: 0 }]),
  );
  const folders = new Set();
  let recent = [];
  let largest = []; // 10 самых больших файлов
  let complete = true;
  const perStorage = [];

  for (const st of all()) {
    // files/size — файлы файлообменника; bucketObjects/bucketSize — ВЕСЬ бакет, включая
    // объекты, загруженные другими программами: это реально занятое место у провайдера.
    const item = { id: st.id, name: st.name, files: 0, size: 0, bucketObjects: 0, bucketSize: 0,
      quota: (st.def.quotaGb || 0) * GB, acceptUploads: st.def.acceptUploads, storageClass: st.def.storageClass || null,
      complete: true, error: null };
    try {
      const down = skipWhileDown(st);
      if (down) throw down;
      item.complete = await st.forEachBucketObject((key, size, lastModified) => {
        item.bucketObjects += 1;
        item.bucketSize += size;
        if (!key.startsWith(st.prefix)) return; // вне папки хранилища — только в общем объёме
        const rel = st.rel(key);
        if (rel.endsWith('/')) {
          if (rel) folders.add(rel);
          return;
        }
        if (!isValidKey(rel)) return; // не формат файлообменника
        const file = fileInfo(st, rel, size, lastModified);
        file.folder = folderFromKey(rel);
        item.files += 1;
        item.size += size;
        const cat = categories[categoryOf(file.name)];
        cat.count += 1;
        cat.size += size;
        for (const f of parentFolders(file.folder)) folders.add(f);
        recent.push(file);
        if (recent.length > 64) recent = recent.sort(byDateDesc).slice(0, 8);
        if (largest.length < 10 || size > largest[largest.length - 1].size) {
          largest.push(file);
          largest = largest.sort((a, b) => b.size - a.size).slice(0, 10);
        }
      }, { max: STATS_MAX_OBJECTS });
      markOk(st.id);
    } catch (err) {
      if (!err.skipped) markFailed(st.id, err);
      item.error = err.skipped ? err.message : describeS3Error(err);
      item.complete = false;
    }
    complete &&= item.complete;
    perStorage.push(item);
  }
  return {
    files: perStorage.reduce((a, s) => a + s.files, 0),
    size: perStorage.reduce((a, s) => a + s.size, 0),
    folders: folders.size,
    categories,
    recent: recent.sort(byDateDesc).slice(0, 8),
    largest,
    complete,
    storages: perStorage,
  };
}

/** @param {{maxAge?: number}} opts — насколько старый кэш устраивает */
export async function getStats({ maxAge = STATS_TTL } = {}) {
  if (statsCache && Date.now() - statsCache.at <= maxAge) return statsCache.data;
  // Параллельные запросы ждут один и тот же подсчёт.
  if (!pendingStats) {
    const generation = statsGeneration;
    const snapshot = new Map(reserved);
    pendingStats = computeStats()
      .then((data) => {
        if (generation === statsGeneration) statsCache = { at: Date.now(), data };
        recordUsage(data);
        lastStats = { at: Date.now(), data };
        // Загрузки, учтённые до начала подсчёта, теперь входят в него — снимаем их резерв.
        for (const [id, v] of snapshot) reserved.set(id, Math.max(0, (reserved.get(id) ?? 0) - v));
        return data;
      })
      .finally(() => { pendingStats = null; });
  }
  return pendingStats;
}

// Загрузки после последнего подсчёта: учитываем их в занятом объёме сразу,
// чтобы несколько файлов подряд распределялись правильно без нового обхода бакетов.
const reserved = new Map(); // storageId -> байты

export function noteUploaded(storageId, size) {
  reserved.set(storageId, (reserved.get(storageId) ?? 0) + size);
}

// ---------- выбор хранилища для нового файла ----------

/**
 * Чистая функция выбора (для тестов).
 * @param {{id, quota, used, acceptUploads}[]} candidates в порядке из настроек
 */
export function choosePlacement(candidates, size, policy) {
  const fits = candidates.filter((c) => c.acceptUploads && (!c.quota || c.used + size <= c.quota));
  if (!fits.length) return null;
  if (policy === 'balance') {
    // Наименьшая доля заполнения у хранилищ с квотой; без квоты — по занятому объёму.
    const score = (c) => (c.quota ? c.used / c.quota : c.used / (1024 * GB));
    return fits.reduce((best, c) => (score(c) < score(best) ? c : best));
  }
  return fits[0]; // «по порядку»: первое, в котором есть место
}

export async function pickForUpload(size) {
  const list = all();
  const needUsage = config.placement === 'balance' || list.some((st) => st.def.quotaGb > 0);
  // Последний подсчёт годится 5 минут (он не сбрасывается загрузками — их учитывает резерв).
  const stats = !needUsage ? null
    : lastStats && Date.now() - lastStats.at <= 5 * 60_000 ? lastStats.data : await getStats({ maxAge: 0 });
  const candidates = list.map((st) => {
    const s = stats?.storages.find((x) => x.id === st.id);
    return {
      st,
      id: st.id,
      quota: (st.def.quotaGb || 0) * GB,
      // Квота сравнивается с реально занятым местом в бакете (включая чужие объекты).
      used: (s?.bucketSize ?? s?.size ?? 0) + (reserved.get(st.id) ?? 0),
      // Хранилище, которое сейчас не отвечает, для новых файлов не используем.
      acceptUploads: st.def.acceptUploads && !recentlyFailed(st.id),
    };
  });
  const chosen = choosePlacement(candidates, size, config.placement);
  if (!chosen) {
    const down = list.filter((st) => st.def.acceptUploads && recentlyFailed(st.id));
    if (down.length) {
      throw Object.assign(new Error(`Хранилище «${down.map((st) => st.name).join('», «')}» сейчас недоступно, а других для новых файлов нет. Попробуйте позже.`), { status: 503 });
    }
    throw Object.assign(new Error('Нет места: ни одно хранилище не принимает новые файлы или все квоты исчерпаны'), { status: 507 });
  }
  return chosen.st;
}
