// Корзина: удалённые файлы и папки хранятся N дней (TRASH_DAYS) и восстанавливаются одной кнопкой.
//
// Объекты переезжают в служебную папку того же бакета: «.trash/<партия>/<прежний ключ>».
// Копирование внутри бакета (CopyObject) не гоняет байты через VDS. Партия — одно удаление
// (файл или папка со всем содержимым во всех хранилищах); её id начинается с метки времени,
// поэтому просроченные партии находятся даже без индекса.
//
// Индекс партий (что удалено, кем, когда, сколько) — data/trash.json (0600). Источник истины
// — сами объекты в S3: восстановление и очистка работают по префиксу партии.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { formatRef, nameFromKey, TRASH } from './keys.js';
import * as acl from './acl.js';
import * as labels from './labels.js';
import * as storages from './storages.js';

const file = () => path.join(config.dataDir, 'trash.json');
const ID_RE = /^[0-9a-z]{9}-[0-9a-z]{6}$/;
const CONCURRENCY = 8;
const DAY = 86_400_000;
let batches = [];

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (Array.isArray(data)) batches = data;
} catch { /* корзина пуста */ }

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(batches, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

const fail = (status, message) => Object.assign(new Error(message), { status });
export const enabled = () => config.limits.trashDays > 0;
const newId = () => `${Date.now().toString(36).padStart(9, '0')}-${crypto.randomBytes(6).toString('hex').slice(0, 6)}`;
const timeOf = (id) => parseInt(id.slice(0, 9), 36);
const prefixOf = (id) => `${TRASH}${id}/`;

/** Параллельная обработка с ограничением одновременных запросов. */
function pool() {
  const running = new Set();
  return {
    async add(task) {
      while (running.size >= CONCURRENCY) await Promise.race(running);
      const p = task().finally(() => running.delete(p));
      running.add(p);
    },
    async done() { await Promise.all(running); },
  };
}

async function moveOne(st, rel, id) {
  const head = await st.headObject(rel);
  if (!head) return null;
  const size = head.ContentLength ?? 0;
  await st.copyObject(rel, prefixOf(id) + rel, size, head.ContentType, head.StorageClass ?? st.storageClass);
  await st.deleteObject(rel);
  return { st, rel, size };
}

/**
 * Файлы в корзину одной записью (удаление нескольких выбранных — одна строка в корзине).
 * @param {{st, rel}[]} refs
 * @returns {Promise<{entry, moved: {st, rel, size}[], failed: number}>}
 */
export async function trashFiles(refs, user) {
  const id = newId();
  const moved = [];
  let failed = 0;
  const work = pool();
  for (const { st, rel } of refs) {
    await work.add(async () => {
      try {
        const r = await moveOne(st, rel, id);
        if (r) moved.push(r); else failed += 1;
      } catch (err) {
        failed += 1;
        console.error(`[trash] «${rel}» не перемещён в корзину:`, err?.name, err?.message);
      }
    });
  }
  await work.done();
  if (!moved.length) throw fail(refs.length === 1 ? 404 : 502, refs.length === 1 ? 'Файл не найден' : 'Не удалось удалить файлы');
  moved.sort((x, y) => refs.findIndex((r) => r.rel === x.rel) - refs.findIndex((r) => r.rel === y.rel));
  const first = moved[0];
  const entry = {
    id,
    kind: moved.length === 1 ? 'file' : 'files',
    name: moved.length === 1 ? nameFromKey(first.rel) : moved.slice(0, 3).map((m) => nameFromKey(m.rel)).join(', '),
    key: moved.length === 1 ? formatRef(first.st.id, first.rel) : undefined,
    keys: moved.length > 1 ? moved.map((m) => formatRef(m.st.id, m.rel)) : undefined,
    sizes: moved.length > 1 ? moved.map((m) => m.size) : undefined,
    folder: first.rel.slice(0, first.rel.lastIndexOf('/') + 1),
    storages: [...new Set(moved.map((m) => m.st.id))],
    count: moved.length,
    size: moved.reduce((a, m) => a + m.size, 0),
    deletedBy: user,
    deletedAt: new Date().toISOString(),
  };
  batches.unshift(entry);
  persist();
  return { entry, moved, failed };
}

/** Папку со всем содержимым (во всех хранилищах) в корзину. */
export async function trashFolder(folderPath, user) {
  const id = newId();
  const ids = [];
  const { values, warnings } = await storages.everywhere(async (st) => {
    const r = await st.movePrefix(folderPath, prefixOf(id) + folderPath);
    if (r.count) ids.push(st.id);
    return r;
  });
  const count = values.reduce((a, v) => a + v.count, 0);
  const size = values.reduce((a, v) => a + v.size, 0);
  const name = folderPath.slice(0, -1).split('/').pop();
  const entry = { id, kind: 'folder', name, folder: folderPath, storages: ids, count, size, deletedBy: user, deletedAt: new Date().toISOString() };
  if (count) {
    batches.unshift(entry);
    persist();
  }
  return { entry, warnings };
}

const expiresAt = (b) => new Date(Date.parse(b.deletedAt) + config.limits.trashDays * DAY).toISOString();
export const list = () => batches.map((b) => ({ ...b, expiresAt: expiresAt(b) }));
export const get = (id) => (typeof id === 'string' && ID_RE.test(id) ? batches.find((b) => b.id === id) ?? null : null);

function forget(id) {
  batches = batches.filter((b) => b.id !== id);
  persist();
}

// Стёрто навсегда — метки больше не нужны (пока лежит в корзине, метка хранится).
function forgetLabels(b) {
  if (b.kind === 'folder') {
    labels.forgetFolder(b.folder);
    acl.forgetFolder(b.folder);
  }
  else for (const key of b.keys ?? [b.key]) labels.forget(key);
}

/** Вернуть партию на прежнее место. */
export async function restore(id) {
  const b = get(id);
  if (!b) throw fail(404, 'В корзине такого нет');
  const prefix = prefixOf(id);
  const { values, warnings } = await storages.everywhere((st) => st.movePrefix(prefix, ''));
  if (!values.some((v) => v.count)) {
    forget(id);
    throw fail(410, 'Файлы этой записи уже удалены из хранилища');
  }
  if (!warnings.length) forget(id);
  return { entry: b, warnings };
}

/**
 * Один файл из записи «N файлов»: вернуть на место (restore) или стереть навсегда.
 * Остальные файлы записи остаются в корзине.
 */
export async function takeOut(id, key, { restore: back }) {
  const b = get(id);
  if (!b) throw fail(404, 'В корзине такого нет');
  const i = (b.keys ?? []).indexOf(key);
  if (b.kind !== 'files' || i < 0) throw fail(404, 'Такого файла в этой записи нет');
  const i2 = key.indexOf(':');
  const st = storages.get(key.slice(0, i2));
  if (!st) throw fail(503, 'Хранилище этого файла отключено');
  const rel = key.slice(i2 + 1);
  const inTrash = prefixOf(id) + rel;
  if (back) {
    const head = await st.headObject(inTrash);
    if (!head) throw fail(410, 'Файл уже удалён из хранилища');
    await st.copyObject(inTrash, rel, head.ContentLength ?? 0, head.ContentType, head.StorageClass ?? st.storageClass);
  }
  await st.deleteObject(inTrash);
  if (!back) labels.forget(key);
  const size = b.sizes?.[i] ?? 0;
  b.keys = b.keys.filter((_, j) => j !== i);
  b.sizes = b.sizes?.filter((_, j) => j !== i);
  b.count = b.keys.length;
  b.size = Math.max(0, b.size - size);
  if (!b.keys.length) forget(id);
  else {
    if (b.keys.length === 1) { // остался один — это обычная запись «файл»
      b.kind = 'file';
      b.key = b.keys[0];
      b.keys = undefined;
      b.sizes = undefined;
    }
    const names = (b.keys ?? [b.key]).map((k) => nameFromKey(k.slice(k.indexOf(':') + 1)));
    b.name = names.length === 1 ? names[0] : names.slice(0, 3).join(', ');
    persist();
  }
  return { entry: b, key };
}

/** Удалить партию навсегда. */
export async function purge(id) {
  const b = get(id);
  if (!b) throw fail(404, 'В корзине такого нет');
  const { warnings } = await storages.everywhere((st) => st.deleteFolder(prefixOf(id)));
  if (!warnings.length) {
    forget(id);
    forgetLabels(b);
  }
  return { entry: b, warnings };
}

/** Очистить корзину целиком. */
export async function empty() {
  const { values, warnings } = await storages.everywhere((st) => st.deleteFolder(TRASH));
  if (!warnings.length) {
    batches.forEach(forgetLabels);
    batches = [];
    persist();
  }
  return { deleted: values.reduce((a, b) => a + b, 0), warnings };
}

/**
 * Удалить просроченное. Смотрит в сами бакеты, а не только в индекс: партия, потерянная
 * индексом (например, после переноса data/), тоже не останется навсегда.
 */
export async function purgeExpired(now = Date.now()) {
  const days = config.limits.trashDays;
  if (!days) return 0;
  const cutoff = now - days * DAY;
  let removed = 0;
  for (const st of storages.all()) {
    try {
      let doomed = [];
      await st.forEachObject(TRASH, async (o) => {
        const id = o.rel.slice(TRASH.length).split('/')[0];
        if (!ID_RE.test(id) || timeOf(id) > cutoff) return;
        doomed.push(o.rel);
        if (doomed.length >= 1000) { await st.deleteMany(doomed); removed += doomed.length; doomed = []; }
      });
      if (doomed.length) { await st.deleteMany(doomed); removed += doomed.length; }
    } catch (err) {
      console.error(`[trash] очистка «${st.name}» не удалась:`, err?.name, err?.message);
    }
  }
  const before = batches.length;
  batches.filter((b) => timeOf(b.id) <= cutoff).forEach(forgetLabels);
  batches = batches.filter((b) => timeOf(b.id) > cutoff);
  if (batches.length !== before) persist();
  if (removed) storages.invalidateStats();
  return removed;
}

export function startAutoPurge() {
  const run = () => purgeExpired().catch((err) => console.error('[trash]', err?.message));
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 3600_000).unref();
}
