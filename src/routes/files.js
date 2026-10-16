// API файлов и папок единого диска (одно или несколько S3-хранилищ, см. storages.js).
import { hasRole, requireRole } from '../auth.js';
import { config } from '../config.js';
import { Router } from '../http.js';
import {
  folderFromKey, generateKey, isValidFolder, isValidKey, nameFromKey, previewKind, rebuildKey,
  safeContentType, sanitizeFileName, sanitizeFolderName, formatRef, isReservedFolder, extOf, contentDisposition,
} from '../keys.js';
import { audit, HttpError } from '../middleware/security.js';
import { pipeline } from 'node:stream/promises';
import { OFFICE_EXT, renderOffice } from '../office.js';
import { entryStream, listZip } from '../zip.js';
import { writeZip } from '../zip-writer.js';
import crypto from 'node:crypto';
import * as acl from '../acl.js';
import * as comments from '../comments.js';
import * as duplicates from '../duplicates.js';
import * as folderIds from '../folder-ids.js';
import * as labels from '../labels.js';
import * as sharesStore from '../shares.js';
import * as storages from '../storages.js';
import { usageHistory } from '../usage-history.js';
import { startTransfer } from '../transfer.js';
import * as trash from '../trash.js';
import * as uploadFlow from '../upload-flow.js';
import * as urlImport from '../url-import.js';

export const filesRouter = Router();

const canEdit = requireRole('editor');
const MAX_PARTS = 10_000; // ограничение S3
const MB = 1024 * 1024;
const LINK_TTLS = new Set([3600, 24 * 3600, 7 * 24 * 3600]);
const PREVIEW_TTL = 15 * 60;

function requireFolder(folder) {
  const value = folder ?? '';
  if (!isValidFolder(value) || isReservedFolder(value)) throw new HttpError(400, 'Некорректный путь папки');
  return value;
}

// Загрузка папки целиком: относительный путь файла внутри перетащенной папки
// (["Фото", "2026"]) — каждое имя очищается так же, как при создании папки.
function withSubfolders(folder, subfolders) {
  if (subfolders === undefined || subfolders === null) return folder;
  if (!Array.isArray(subfolders) || subfolders.length > 20) throw new HttpError(400, 'Некорректный путь папки');
  let path = folder;
  for (const seg of subfolders) {
    const name = typeof seg === 'string' ? sanitizeFolderName(seg) : null;
    if (!name) throw new HttpError(400, 'Некорректное имя папки');
    path += `${name}/`;
  }
  if (!isValidFolder(path)) throw new HttpError(400, 'Слишком глубокая вложенность или длинный путь');
  return path;
}

// Ошибки модулей ({status, message}) → HttpError.
async function flow(fn) {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof HttpError || !err.status ? err : new HttpError(err.status, err.message);
  }
}

export function requireUploadId(uploadId) {
  // eslint-disable-next-line no-control-regex
  if (typeof uploadId !== 'string' || !uploadId || uploadId.length > 1024 || /[\u0000-\u001f]/.test(uploadId)) {
    throw new HttpError(400, 'Некорректный uploadId');
  }
  return uploadId;
}

const { resolveRef, fileInfo } = storages;

// ---------- права на папки (acl.js) ----------
// Нет доступа на чтение — отвечаем как будто папки/файла нет: не раскрываем, что они есть.
function readFolder(req, folder) {
  const f = requireFolder(folder);
  if (!acl.canRead(req.user, f)) throw new HttpError(404, 'Папка не найдена');
  return f;
}
function writeFolder(req, folder) {
  const f = readFolder(req, folder);
  if (!acl.canWrite(req.user, f)) throw new HttpError(403, 'Нет прав на изменения в этой папке');
  return f;
}
// Удаление и перемещение папки затрагивает всё внутри — нужны права на каждую вложенную
// папку со своим правилом (иначе через общую папку можно было бы удалить чужую личную).
function writeTree(req, folder) {
  const f = writeFolder(req, folder);
  if (!acl.canWriteTree(req.user, f)) throw new HttpError(403, 'Внутри есть папки, на которые у вас нет прав');
  return f;
}
function readRef(req, key) {
  const ref = resolveRef(key);
  if (!acl.canRead(req.user, folderFromKey(ref.rel))) throw new HttpError(404, 'Файл не найден');
  return ref;
}
function writeRef(req, key) {
  const ref = readRef(req, key);
  if (!acl.canWrite(req.user, folderFromKey(ref.rel))) throw new HttpError(403, 'Нет прав на изменения в этой папке');
  return ref;
}
const filterAcl = (req) => acl.hasRules() && !acl.isAdmin(req.user);

// Подробности ошибок хранилищ (адреса, порты, коды) видит только администратор:
// обычным пользователям незачем знать внутреннюю инфраструктуру.
const publicWarnings = (req, warnings = []) => (hasRole(req.user, 'admin') ? warnings
  : warnings.map((w) => ({ storage: w.storage, error: 'нет связи с хранилищем' })));

// ---------- квота личной папки ----------
const quotaCache = new Map(); // логин → {at, bytes}
async function personalUsage(user) {
  const cached = quotaCache.get(user.username);
  if (cached && Date.now() - cached.at < 60_000) return cached.bytes;
  const prefix = acl.personalPath(user.username);
  const { values } = await storages.everywhere(async (st) => {
    let sum = 0;
    await st.forEachObject(prefix, (o) => { sum += o.size; });
    return sum;
  });
  const bytes = values.reduce((a, b) => a + b, 0);
  quotaCache.set(user.username, { at: Date.now(), bytes });
  return bytes;
}
function noteQuotaUse(user, size) {
  const cached = quotaCache.get(user.username);
  if (cached) cached.bytes += size;
}
export { personalUsage };

/** Сколько байт во всех хранилищах под префиксом (только то, что пользователь может читать). */
export async function treeSize(prefix, user) {
  const filter = user && acl.hasRules() && !acl.isAdmin(user);
  const { values } = await storages.everywhere(async (st) => {
    let sum = 0;
    await st.forEachObject(prefix, (o) => { if (!filter || acl.canRead(user, folderFromKey(o.rel))) sum += o.size; });
    return sum;
  });
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Копирование и перемещение в личную папку тоже расходуют квоту, как загрузка.
 * Бросает 507, если места не хватает; иначе учитывает размер в кеше занятого места.
 */
export async function reserveQuota(user, folder, size) {
  if (!user.quotaMb || !acl.inPersonal(user, folder)) return;
  await quotaLimit(user, folder, size);
  noteQuotaUse(user, size);
}

/** Сколько ещё можно положить в папку с учётом квоты (undefined — квоты нет). */
async function quotaLimit(user, folder, size) {
  if (!user.quotaMb || !acl.inPersonal(user, folder)) return undefined;
  const left = user.quotaMb * MB - await personalUsage(user);
  if (left <= 0 || (Number.isSafeInteger(size) && size > left)) {
    throw new HttpError(507, `Не хватает места в личной папке: свободно ${Math.max(0, Math.floor(left / MB))} МБ из ${user.quotaMb} МБ`);
  }
  return Math.min(config.limits.maxFileSize, left);
}

// GET /api/personal → {path, quotaMb, used} — личная папка и сколько в ней занято
filesRouter.get('/personal', async (req, res) => {
  if (!acl.hasPersonal(req.user)) return res.json({ personal: null });
  const used = await personalUsage(req.user).catch(() => null);
  res.json({ personal: { path: acl.personalPath(req.user.username), quotaMb: req.user.quotaMb ?? 0, used } });
});

// ---------- статистика ----------
filesRouter.get('/stats', async (req, res) => {
  let stats = { ...(await storages.getStats()), history: usageHistory() };
  if (hasRole(req.user, 'admin')) return res.json(stats);
  if (filterAcl(req)) {
    const ok = (f) => acl.canRead(req.user, f.folder);
    stats = { ...stats, recent: stats.recent.filter(ok), largest: stats.largest.filter(ok) };
  }
  res.json({ ...stats, storages: stats.storages.map((s) => ({ ...s, error: s.error ? 'нет связи с хранилищем' : null })) });
});

// ---------- папки ----------

// GET /api/files?folder=a/b/&cursor=... — подпапки и файлы папки из всех хранилищ, новые сверху.
filesRouter.get('/files', async (req, res) => {
  const folder = requireFolder(typeof req.query.folder === 'string' ? req.query.folder : '');
  if (!acl.canSee(req.user, folder)) throw new HttpError(404, 'Папка не найдена');
  let cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  // Курсор — последний выданный ключ этой же папки (файл или подпапка).
  if (cursor !== undefined && (!cursor.startsWith(folder) || !(isValidKey(cursor) || isValidFolder(cursor)))) {
    throw new HttpError(400, 'Некорректный курсор');
  }
  if (cursor === '') cursor = undefined;
  const result = await storages.listFolder(folder, { cursor });
  if (filterAcl(req)) {
    result.folders = result.folders.filter((f) => acl.canSee(req.user, f.path));
    // Папка-«проход» к доступной подпапке: своих файлов не показывает.
    if (!acl.canRead(req.user, folder)) result.files = [];
  }
  const access = acl.access(req.user, folder);
  if (folder) folderIds.remember(folder);
  for (const f of result.folders) folderIds.remember(f.path);
  // Замок у папок со своими правилами (видят администраторы) и у личных папок.
  for (const f of result.folders) {
    const rule = acl.getRule(f.path).own;
    if (rule?.personal) f.personal = rule.personal;
    else if (rule && acl.isAdmin(req.user)) f.restricted = true;
  }
  const publicOf = sharesStore.publicIndex();
  for (const f of result.files) {
    f.label = labels.get(f.key) ?? undefined;
    f.public = publicOf(f.key, folder) ?? undefined; // {downloads, active} — счётчик скачиваний по ссылкам
    f.comments = comments.count(f.key) || undefined;
  }
  for (const f of result.folders) f.label = labels.get(labels.folderId(f.path)) ?? undefined;
  res.json({ folder, access, ...result, warnings: publicWarnings(req, result.warnings) });
});

// GET /api/search?q=&category=&label= — поиск по всему диску (имя, тип, метка)
const CATEGORIES = ['image', 'video', 'audio', 'document', 'archive', 'other'];
filesRouter.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : undefined;
  const label = labels.COLORS.includes(req.query.label) ? req.query.label : undefined;
  if (!q.trim() && !category && !label) throw new HttpError(400, 'Введите, что искать');
  const byLabel = label && ((key, isFolder) => labels.get(isFolder ? labels.folderId(key) : key) === label);
  const byAcl = filterAcl(req) && ((key, isFolder) => acl.canRead(req.user, isFolder ? key : folderFromKey(key.slice(key.indexOf(':') + 1))));
  const match = (byLabel || byAcl) ? (key, isFolder) => (!byAcl || byAcl(key, isFolder)) && (!byLabel || byLabel(key, isFolder)) : undefined;
  const result = await storages.search({ q, category, match });
  for (const f of result.folders) folderIds.remember(f.path);
  for (const f of result.files) if (f.folder) folderIds.remember(f.folder);
  for (const f of result.files) f.label = labels.get(f.key) ?? undefined;
  for (const f of result.folders) f.label = labels.get(labels.folderId(f.path)) ?? undefined;
  res.json({ ...result, warnings: publicWarnings(req, result.warnings) });
});

// PUT /api/labels {key | folder, color|null} — цветная метка файла или папки
filesRouter.put('/labels', canEdit, async (req, res) => {
  const color = req.body?.color ?? null;
  if (color !== null && !labels.COLORS.includes(color)) throw new HttpError(400, 'Неизвестный цвет метки');
  let id;
  if (req.body?.folder !== undefined) {
    const path = writeFolder(req, req.body.folder);
    if (!path) throw new HttpError(400, 'Корню метку не поставить');
    id = labels.folderId(path);
  } else {
    const { st, rel } = writeRef(req, req.body?.key);
    id = formatRef(st.id, rel);
  }
  if (!labels.set(id, color)) throw new HttpError(507, 'Слишком много меток');
  res.json({ ok: true, color });
});

// GET /api/folders/id/:id → {path} — путь папки по короткому ID из адреса страницы.
filesRouter.get('/folders/id/:id', async (req, res) => {
  const path = await folderIds.resolve(req.params.id);
  if (path === null || !acl.canSee(req.user, path)) throw new HttpError(404, 'Папка не найдена — возможно, её переименовали или удалили');
  res.json({ path });
});

// POST /api/folders {parent, name} — создать папку (во всех хранилищах).
filesRouter.post('/folders', canEdit, async (req, res) => {
  const parent = writeFolder(req, req.body?.parent);
  const name = sanitizeFolderName(req.body?.name);
  if (!name) throw new HttpError(400, 'Введите название папки');
  const path = `${parent}${name}/`;
  if (!isValidFolder(path)) throw new HttpError(400, 'Слишком глубокая вложенность или длинный путь');
  const { warnings } = await storages.createFolder(path);
  storages.invalidateStats();
  folderIds.remember(path);
  audit(req, 'folder.create', { path });
  res.status(201).json({ folder: { path, name }, warnings: publicWarnings(req, warnings) });
});

// POST /api/folders/move {path, parent?, name?} — переименовать и/или переместить папку
// со всем содержимым (во всех хранилищах; копирование внутри бакетов).
filesRouter.post('/folders/move', canEdit, async (req, res) => {
  const path = writeTree(req, req.body?.path);
  if (!path) throw new HttpError(400, 'Корневую папку переместить нельзя');
  if (acl.isPersonalRoot(path) && !acl.isAdmin(req.user)) throw new HttpError(403, 'Личную папку переместить нельзя');
  const currentName = path.slice(0, -1).split('/').pop();
  const currentParent = path.slice(0, path.length - currentName.length - 1);
  const parent = req.body?.parent === undefined ? currentParent : writeFolder(req, req.body.parent);
  const name = req.body?.name === undefined ? currentName : sanitizeFolderName(req.body.name);
  if (!name) throw new HttpError(400, 'Введите название папки');
  const target = `${parent}${name}/`;
  if (!isValidFolder(target)) throw new HttpError(400, 'Слишком глубокая вложенность или длинный путь');
  if (target === path) return res.json({ ok: true, folder: { path, name }, moved: 0 });
  if (target.startsWith(path)) throw new HttpError(400, 'Нельзя переместить папку внутрь неё самой');
  if (req.user.quotaMb && acl.inPersonal(req.user, target) && !acl.inPersonal(req.user, path)) {
    await reserveQuota(req.user, target, await treeSize(path));
  }
  const { moved, warnings } = await flow(() => storages.moveFolder(path, target));
  storages.invalidateStats();
  sharesStore.refolder(path, target);
  labels.refolder(path, target);
  acl.refolder(path, target);
  folderIds.remember(target);
  audit(req, 'folder.move', { from: path, to: target, moved });
  res.json({ ok: true, folder: { path: target, name }, moved, warnings: publicWarnings(req, warnings) });
});

// POST /api/folders/delete {path} — удалить папку со всем содержимым во всех хранилищах.
filesRouter.post('/folders/delete', canEdit, async (req, res) => {
  const path = writeTree(req, req.body?.path);
  if (!path) throw new HttpError(400, 'Корневую папку удалить нельзя');
  if (acl.isPersonalRoot(path) && !acl.isAdmin(req.user)) throw new HttpError(403, 'Личную папку удалить нельзя');
  if (trash.enabled()) {
    const { entry, warnings } = await trash.trashFolder(path, req.user.username);
    storages.invalidateStats();
    sharesStore.folderGone(path);
    audit(req, 'folder.trash', { path, count: entry.count });
    return res.json({ ok: true, deleted: entry.count, trashed: true, trashId: entry.count ? entry.id : undefined, warnings: publicWarnings(req, warnings) });
  }
  const { deleted, warnings } = await storages.deleteFolder(path);
  storages.invalidateStats();
  sharesStore.folderGone(path);
  labels.forgetFolder(path);
  acl.forgetFolder(path);
  audit(req, 'folder.delete', { path, deleted });
  res.json({ ok: true, deleted, warnings: publicWarnings(req, warnings) });
});

// ---------- загрузка ----------

// POST /api/uploads — начало загрузки. Сервер выбирает хранилище, ключ и способ загрузки.
filesRouter.post('/uploads', canEdit, async (req, res) => {
  const folder = withSubfolders(writeFolder(req, req.body?.folder), req.body?.subfolders);
  if (!acl.canWrite(req.user, folder)) throw new HttpError(403, 'Нет прав на изменения в этой папке');
  const { name, size, type } = req.body ?? {};
  const maxSize = await quotaLimit(req.user, folder, size);
  res.json(await flow(() => uploadFlow.planUpload({ name, size, type, folder, maxSize })));
});

// ---------- загрузка по ссылке (сервер скачивает файл сам) ----------
// POST /api/uploads/url {url, folder} → 202 {job}; статус — GET /api/uploads/url/:id
filesRouter.post('/uploads/url', canEdit, async (req, res) => {
  const folder = writeFolder(req, req.body?.folder);
  if (acl.inPersonal(req.user, folder) && req.user.quotaMb) throw new HttpError(400, 'В личную папку с квотой загрузите файл с компьютера');
  const job = await urlImport.startImport({
    url: req.body?.url, folder, user: req.user.username,
    onDone: (j) => {
      if (j.status === 'done') audit(req, 'file.upload_url', { host: j.host, key: j.file.key, size: j.size });
    },
  });
  res.status(202).json({ job });
});

filesRouter.get('/uploads/url/:id', canEdit, (req, res) => {
  const job = urlImport.getJob(req.params.id, req.user.username);
  if (!job) throw new HttpError(404, 'Задание не найдено');
  res.json({ job });
});

filesRouter.post('/uploads/url/:id/cancel', canEdit, (req, res) => {
  if (!urlImport.cancelJob(req.params.id, req.user.username)) throw new HttpError(404, 'Задание не найдено');
  res.json({ ok: true });
});

// ---------- фоновые задания: перенос между хранилищами ----------
// POST /api/files/transfer {key, storage} → 202 {job}
filesRouter.post('/files/transfer', canEdit, async (req, res) => {
  const storage = req.body?.storage;
  if (typeof storage !== 'string') throw new HttpError(400, 'Не указано хранилище');
  writeRef(req, req.body?.key);
  try {
    const job = await startTransfer({
      key: req.body?.key, storageId: storage, user: req.user.username,
      onDone: (j) => {
        if (j.status !== 'done') return;
        sharesStore.rekeyFile(req.body.key, j.file.key);
        labels.rekey(req.body.key, j.file.key);
        audit(req, 'file.transfer', { key: j.file.key, to: j.target, size: j.size });
      },
    });
    res.status(202).json({ job });
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(err.status ?? 400, err.message);
  }
});

filesRouter.get('/jobs/:id', canEdit, (req, res) => {
  const job = urlImport.getJob(req.params.id, req.user.username);
  if (!job) throw new HttpError(404, 'Задание не найдено');
  res.json({ job });
});

filesRouter.post('/jobs/:id/cancel', canEdit, (req, res) => {
  if (!urlImport.cancelJob(req.params.id, req.user.username)) throw new HttpError(404, 'Задание не найдено');
  res.json({ ok: true });
});

// POST /api/uploads/parts — presigned URL для пачки частей multipart-загрузки.
filesRouter.post('/uploads/parts', canEdit, async (req, res) => {
  const uploadId = requireUploadId(req.body?.uploadId);
  writeRef(req, req.body?.key);
  res.json({ urls: await flow(() => uploadFlow.presignParts(req.body?.key, uploadId, req.body?.partNumbers)) });
});

// POST /api/uploads/complete — подтверждение загрузки и проверка лимита размера.
// Presigned PUT не ограничивает размер тела, поэтому лимит проверяется здесь,
// а превысившие его объекты сразу удаляются.
filesRouter.post('/uploads/complete', canEdit, async (req, res) => {
  const uploadId = req.body?.uploadId === undefined ? undefined : requireUploadId(req.body.uploadId);
  const ref = writeRef(req, req.body?.key);
  // Квота: multipart собирается только сейчас — проверяем итоговый размер (одиночный PUT
  // ограничен размером, заданным в подписи ссылки).
  const maxSize = uploadId ? await quotaLimit(req.user, folderFromKey(ref.rel), 0) : undefined;
  const { file, st, rel, size } = await flow(() => uploadFlow.completeUpload(req.body?.key, uploadId, maxSize ? { maxSize } : undefined));
  if (acl.inPersonal(req.user, folderFromKey(rel))) noteQuotaUse(req.user, size);
  audit(req, 'file.upload', { storage: st.id, key: rel, size });
  res.json({ file });
});

// POST /api/uploads/resume {key, uploadId} → {parts: [{n, size}]} — что уже загружено.
filesRouter.post('/uploads/resume', canEdit, async (req, res) => {
  const uploadId = requireUploadId(req.body?.uploadId);
  writeRef(req, req.body?.key);
  res.json({ parts: await flow(() => uploadFlow.uploadedParts(req.body?.key, uploadId)) });
});

// POST /api/uploads/abort — отмена multipart-загрузки (освобождает место в бакете).
filesRouter.post('/uploads/abort', canEdit, async (req, res) => {
  writeRef(req, req.body?.key);
  await uploadFlow.abortUpload(req.body?.key, requireUploadId(req.body?.uploadId));
  res.json({ ok: true });
});

// ---------- файлы ----------

// POST /api/files/link — временная ссылка на скачивание напрямую из S3.
filesRouter.post('/files/link', async (req, res) => {
  const { st, rel } = readRef(req, req.body?.key);
  const ttl = req.body?.ttl ?? 24 * 3600;
  if (!LINK_TTLS.has(ttl) || ttl > config.limits.maxDownloadTtlSec) {
    throw new HttpError(400, 'Недопустимый срок действия ссылки');
  }
  if (!(await st.headObject(rel))) throw new HttpError(404, 'Файл не найден');
  const url = await st.presignGet(rel, ttl);
  res.json({ url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() });
});

// POST /api/files/thumbs {keys} — ссылки на миниатюры изображений для вида «Плитки».
// Только подпись ссылок (без запросов к S3), пачкой — одна ссылка на страницу списка.
// Отсутствующий файл просто не покажет картинку. Тип ответа — из белого списка.
filesRouter.post('/files/thumbs', async (req, res) => {
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || keys.length > 200) throw new HttpError(400, 'Некорректный список файлов');
  const urls = {};
  for (const key of keys) {
    const { st, rel } = resolveRef(key);
    if (!acl.canRead(req.user, folderFromKey(rel))) continue;
    const preview = previewKind(nameFromKey(rel));
    if (preview?.kind !== 'image') continue;
    urls[key] = await st.presignGet(rel, PREVIEW_TTL, { contentType: preview.contentType });
  }
  res.json({ urls });
});

// POST /api/files/preview — короткоживущая inline-ссылка для предпросмотра.
// Тип ответа S3 задаёт сервер по белому списку расширений (см. keys.js).
filesRouter.post('/files/preview', async (req, res) => {
  const { st, rel } = readRef(req, req.body?.key);
  const head = await st.headObject(rel);
  if (!head) throw new HttpError(404, 'Файл не найден');
  const meta = {
    size: head.ContentLength ?? 0,
    contentType: head.ContentType ?? 'application/octet-stream',
    lastModified: head.LastModified?.toISOString() ?? null,
    storage: { id: st.id, name: st.name },
  };
  const ext = extOf(nameFromKey(rel));
  // Архив и документы Office показывает сервер (читая нужные части диапазонами), без ссылки.
  if (ZIP_EXT.has(ext)) return res.json({ kind: 'zip', ...meta });
  if (OFFICE_EXT.has(ext)) return res.json({ kind: 'office', ...meta });
  const preview = previewKind(nameFromKey(rel));
  if (!preview) return res.json({ kind: null, ...meta });
  // inline — только для PDF (его показывает iframe). Картинки, видео и аудио браузер отображает
  // в <img>/<video> и с «attachment», а при прямом открытии ссылки файл просто скачается:
  // загруженный SVG/HTML не сможет выполнить скрипт даже на домене хранилища.
  const url = await st.presignGet(rel, PREVIEW_TTL, { inline: preview.kind === 'pdf', contentType: preview.contentType });
  res.json({ kind: preview.kind, url, ...meta });
});

// ---------- содержимое архивов и документы Office ----------
const ZIP_EXT = new Set(['zip', 'jar', 'apk', 'epub', 'cbz']);

async function zipSource(req, key) {
  const { st, rel } = readRef(req, key);
  const head = await st.headObject(rel);
  if (!head) throw new HttpError(404, 'Файл не найден');
  return { st, rel, size: head.ContentLength ?? 0 };
}

// POST /api/files/zip {key} → {entries, total, truncated} — оглавление архива.
filesRouter.post('/files/zip', async (req, res) => {
  const { st, rel, size } = await zipSource(req, req.body?.key);
  const { entries, total, truncated } = await flow(() => listZip(st, rel, size));
  res.json({ entries: entries.map(({ offset, ...e }) => e), total, truncated });
});

// GET /api/files/zip/entry?key=&i= — скачать один файл из архива (распаковка потоком на сервере).
filesRouter.get('/files/zip/entry', async (req, res) => {
  const { st, rel, size } = await zipSource(req, req.query.key);
  const i = Number(req.query.i);
  const { entries } = await flow(() => listZip(st, rel, size));
  const entry = Number.isInteger(i) ? entries[i] : undefined;
  if (!entry) throw new HttpError(404, 'Такого файла в архиве нет');
  const { stream } = await flow(() => entryStream(st, rel, entry));
  const name = sanitizeFileName(entry.name.split('/').filter(Boolean).pop() ?? 'file') || 'file';
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(name));
  res.setHeader('Content-Length', entry.size);
  res.setHeader('Cache-Control', 'private, no-store');
  if (!stream) return res.end();
  try {
    await pipeline(stream, res);
  } catch (err) {
    // Заголовки уже ушли — остаётся оборвать соединение (браузер покажет «ошибка загрузки»).
    console.error('[zip] распаковка прервана:', err?.message);
    res.destroy();
  }
});

// POST /api/files/office {key} — docx/xlsx/pptx в простую структуру для просмотра.
filesRouter.post('/files/office', async (req, res) => {
  const { st, rel, size } = await zipSource(req, req.body?.key);
  const ext = extOf(nameFromKey(rel));
  if (!OFFICE_EXT.has(ext)) throw new HttpError(400, 'Это не документ Office (docx, xlsx, pptx)');
  if (size > 100 * 1024 * 1024) throw new HttpError(413, 'Документ слишком большой для просмотра');
  res.json(await flow(() => renderOffice(st, rel, size, ext)));
});

// ---------- комментарии ----------
// Видят и пишут все, кто может читать файл; удалить — автор или администратор.
filesRouter.get('/comments', (req, res) => {
  const { st, rel } = readRef(req, req.query.key);
  res.json({ comments: comments.list(formatRef(st.id, rel)) });
});
filesRouter.post('/comments', (req, res) => {
  const { st, rel } = readRef(req, req.body?.key);
  let c;
  try {
    c = comments.add(formatRef(st.id, rel), req.user.username, req.body?.text);
  } catch (err) {
    throw new HttpError(err.status ?? 400, err.message);
  }
  audit(req, 'comment.add', { key: rel });
  res.status(201).json({ comment: c });
});
filesRouter.delete('/comments', (req, res) => {
  const { st, rel } = readRef(req, req.query.key);
  const r = comments.remove(formatRef(st.id, rel), String(req.query.id ?? ''), req.user.username, acl.isAdmin(req.user));
  if (r === null) throw new HttpError(404, 'Комментарий не найден');
  if (!r) throw new HttpError(403, 'Удалить можно только свой комментарий');
  res.json({ ok: true });
});

// ---------- дубликаты ----------
// GET /api/duplicates[?refresh=1] → {groups: [{size, files}], reclaimable, scannedAt}
// Только файлы, которые пользователь может читать; группа — от двух таких файлов.
filesRouter.get('/duplicates', async (req, res) => {
  const result = await duplicates.find({ refresh: req.query.refresh === '1' });
  const filter = filterAcl(req);
  const groups = [];
  let reclaimable = 0;
  for (const g of result.groups) {
    const files = (filter ? g.filter((f) => acl.canRead(req.user, folderFromKey(f.rel))) : g)
      .map((f) => ({ key: f.key, name: nameFromKey(f.rel), folder: folderFromKey(f.rel), size: f.size, lastModified: f.lastModified }));
    if (files.length < 2) continue;
    groups.push({ size: files[0].size, files });
    reclaimable += (files.length - 1) * files[0].size;
  }
  res.json({ groups, reclaimable, scannedAt: new Date(result.at).toISOString(), warnings: publicWarnings(req, result.warnings) });
});

// ---------- скачать папку или выбранные файлы одним ZIP ----------
// POST /api/files/archive {folder} | {keys} → {url} — одноразовая ссылка на минуту;
// GET по ней собирает архив потоком: файлы идут из S3 в ответ по очереди, без сжатия.
const ARCHIVE_MAX_FILES = 10_000;
const archives = new Map(); // токен → {user, name, entries, exp}

function uniqueName(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const slash = name.lastIndexOf('/');
  const [base, ext] = dot > slash + 1 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) {
    const next = `${base} (${i})${ext}`;
    if (!used.has(next)) { used.add(next); return next; }
  }
}

filesRouter.post('/files/archive', async (req, res) => {
  const items = []; // {st, rel, size, lastModified, path}
  let name;
  if (Array.isArray(req.body?.keys)) {
    if (!req.body.keys.length || req.body.keys.length > 1000) throw new HttpError(400, 'Выберите от 1 до 1000 файлов');
    for (const key of req.body.keys) {
      const { st, rel } = readRef(req, key);
      items.push({ st, rel, path: nameFromKey(rel) });
    }
    name = items.length === 1 ? nameFromKey(items[0].rel).replace(/\.[^.]*$/, '') : `Файлы (${items.length})`;
  } else {
    const folder = readFolder(req, req.body?.folder);
    const filter = filterAcl(req);
    let tooMany = false;
    const { warnings } = await storages.everywhere(async (st) => {
      await st.forEachObject(folder, (o) => {
        if (!isValidKey(o.rel) || isReservedFolder(o.rel)) return; // маркеры папок, корзина, копии
        const f = folderFromKey(o.rel);
        if (filter && !acl.canRead(req.user, f)) return;
        if (items.length >= ARCHIVE_MAX_FILES) { tooMany = true; return; }
        items.push({ st, rel: o.rel, size: o.size, lastModified: o.lastModified, path: f.slice(folder.length) + nameFromKey(o.rel) });
      });
    });
    if (tooMany) throw new HttpError(413, `В папке больше ${ARCHIVE_MAX_FILES} файлов — скачайте её частями`);
    if (warnings.length) throw new HttpError(502, 'Часть хранилищ недоступна — архив был бы неполным');
    if (!items.length) throw new HttpError(404, 'В папке нет файлов');
    name = folder ? folder.slice(0, -1).split('/').pop() : 'Мой диск';
  }
  const used = new Set();
  const entries = items.map((it) => ({ ...it, path: uniqueName(it.path, used) }));
  const token = crypto.randomBytes(18).toString('base64url');
  for (const [t, a] of archives) if (a.exp < Date.now()) archives.delete(t);
  archives.set(token, { user: req.user.username, name, entries, exp: Date.now() + 60_000 });
  res.json({ url: `/api/files/archive/${token}`, count: entries.length });
});

filesRouter.get('/files/archive/:token', async (req, res) => {
  const a = archives.get(req.params.token);
  archives.delete(req.params.token);
  if (!a || a.exp < Date.now() || a.user !== req.user.username) throw new HttpError(410, 'Ссылка на архив устарела — нажмите «Скачать» ещё раз');
  // Права проверены при создании ссылки; размеры файлов из выбора — уточняем перед отправкой.
  for (const e of a.entries) {
    if (e.size === undefined) {
      const head = await e.st.headObject(e.rel);
      if (!head) throw new HttpError(404, `Файл «${nameFromKey(e.rel)}» не найден`);
      e.size = head.ContentLength ?? 0;
      e.lastModified = head.LastModified?.toISOString?.() ?? null;
    }
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(`${a.name}.zip`));
  res.setHeader('Cache-Control', 'no-store');
  audit(req, 'files.archive', { name: a.name, count: a.entries.length });
  let aborted = false;
  res.on('close', () => { if (!res.writableFinished) aborted = true; });
  async function* stream() {
    for (const e of a.entries) {
      yield {
        name: e.path, size: e.size, mtime: e.lastModified ? new Date(e.lastModified) : undefined,
        open: async () => (await e.st.getStream(e.rel)).body,
      };
    }
  }
  try {
    await writeZip(res, stream(), { isAborted: () => aborted });
    res.end();
  } catch (err) {
    if (!err.aborted) console.error('[archive] сборка прервана:', err?.name, err?.message);
    res.destroy();
  }
});

// POST /api/files/move {key, folder?, name?} — переименование и/или перемещение файла.
// В S3 нет операции rename: объект копируется под новым ключом внутри своего бакета,
// затем исходный удаляется. Ссылки, выданные на старый ключ, перестают работать.
filesRouter.post('/files/move', canEdit, async (req, res) => {
  const { st, rel } = writeRef(req, req.body?.key);
  const folder = req.body?.folder === undefined ? folderFromKey(rel) : writeFolder(req, req.body.folder);
  let name = nameFromKey(rel);
  if (req.body?.name !== undefined) {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) throw new HttpError(400, 'Введите имя файла');
    if (req.body.name.length > 500) throw new HttpError(400, 'Слишком длинное имя файла');
    name = sanitizeFileName(req.body.name);
  }
  const target = rebuildKey(rel, { folder, name });
  if (!isValidKey(target)) throw new HttpError(400, 'Слишком длинный путь или имя файла');

  const head = await st.headObject(rel);
  if (!head) throw new HttpError(404, 'Файл не найден');
  const size = head.ContentLength ?? 0;
  if (target === rel) return res.json({ file: fileInfo(st, rel, size, head.LastModified), folder });
  if (!acl.inPersonal(req.user, folderFromKey(rel))) await reserveQuota(req.user, folder, size);

  // Класс хранения файла сохраняется (HeadObject не возвращает его для STANDARD).
  await st.copyObject(rel, target, size, head.ContentType, head.StorageClass ?? st.storageClass);
  await st.deleteObject(rel);
  storages.invalidateStats();
  sharesStore.rekeyFile(formatRef(st.id, rel), formatRef(st.id, target));
  labels.rekey(formatRef(st.id, rel), formatRef(st.id, target));
  audit(req, 'file.move', { storage: st.id, from: rel, to: target });
  res.json({ file: fileInfo(st, target, size), folder });
});

// POST /api/files/copy {key, folder?, name?} — копия файла (в том же бакете, байты не идут
// через VDS). Без имени в той же папке получается «имя (копия).ext».
filesRouter.post('/files/copy', canEdit, async (req, res) => {
  const { st, rel } = readRef(req, req.body?.key);
  const sourceFolder = folderFromKey(rel);
  const folder = writeFolder(req, req.body?.folder === undefined ? sourceFolder : req.body.folder);
  let name = nameFromKey(rel);
  if (req.body?.name !== undefined) {
    if (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.length > 500) throw new HttpError(400, 'Введите имя файла');
    name = sanitizeFileName(req.body.name);
  } else if (folder === sourceFolder) {
    const dot = name.lastIndexOf('.');
    name = sanitizeFileName(dot > 0 ? `${name.slice(0, dot)} (копия)${name.slice(dot)}` : `${name} (копия)`);
  }
  const target = generateKey(name, folder);
  if (!isValidKey(target)) throw new HttpError(400, 'Слишком длинный путь или имя файла');

  const head = await st.headObject(rel);
  if (!head) throw new HttpError(404, 'Файл не найден');
  const size = head.ContentLength ?? 0;
  if (st.def.quotaGb > 0) {
    const stats = await storages.getStats();
    const used = stats.storages.find((x) => x.id === st.id)?.bucketSize ?? 0;
    if (used + size > st.def.quotaGb * 1024 ** 3) throw new HttpError(507, `Нет места в хранилище «${st.name}»: квота исчерпана`);
  }
  await reserveQuota(req.user, folder, size);
  await st.copyObject(rel, target, size, head.ContentType, head.StorageClass ?? st.storageClass);
  storages.noteUploaded(st.id, size);
  storages.invalidateStats();
  audit(req, 'file.copy', { storage: st.id, from: rel, to: target });
  res.status(201).json({ file: fileInfo(st, target, size), folder });
});

// DELETE /api/files?key=... — удаление файла.
filesRouter.delete('/files', canEdit, async (req, res) => {
  const { st, rel } = writeRef(req, req.query.key);
  const trashed = trash.enabled();
  let trashId;
  if (trashed) trashId = (await flow(() => trash.trashFiles([{ st, rel }], req.user.username))).entry.id;
  else {
    await st.deleteObject(rel);
    labels.forget(formatRef(st.id, rel));
  }
  storages.invalidateStats();
  sharesStore.fileGone(formatRef(st.id, rel));
  audit(req, trashed ? 'file.trash' : 'file.delete', { storage: st.id, key: rel });
  res.json({ ok: true, trashed, trashId });
});

// POST /api/files/delete {keys} — удалить несколько файлов (в корзину — одной записью).
filesRouter.post('/files/delete', canEdit, async (req, res) => {
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || !keys.length || keys.length > 500) throw new HttpError(400, 'Передайте от 1 до 500 файлов');
  const refs = [...new Set(keys)].map((k) => writeRef(req, k));
  let deleted = [];
  let failed = 0;
  let trashId;
  if (trash.enabled()) {
    const r = await flow(() => trash.trashFiles(refs, req.user.username));
    trashId = r.entry.id;
    deleted = r.moved.map((m) => formatRef(m.st.id, m.rel));
    failed = r.failed;
  } else {
    const byStorage = new Map();
    for (const ref of refs) byStorage.set(ref.st, [...(byStorage.get(ref.st) ?? []), ref.rel]);
    for (const [st, rels] of byStorage) {
      try {
        await st.deleteMany(rels);
        for (const rel of rels) {
          deleted.push(formatRef(st.id, rel));
          labels.forget(formatRef(st.id, rel));
        }
      } catch (err) {
        failed += rels.length;
        console.error(`[storage ${st.name}] удаление не удалось:`, err?.name, err?.message);
      }
    }
  }
  storages.invalidateStats();
  for (const key of deleted) sharesStore.fileGone(key);
  audit(req, trash.enabled() ? 'file.trash' : 'file.delete', { count: deleted.length, keys: deleted.slice(0, 20) });
  res.json({ ok: true, deleted, failed, trashed: trash.enabled(), trashId });
});
