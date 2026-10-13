// API файлов и папок единого диска (одно или несколько S3-хранилищ, см. storages.js).
import { hasRole, requireRole } from '../auth.js';
import { config } from '../config.js';
import { Router } from '../http.js';
import {
  folderFromKey, generateKey, isValidFolder, isValidKey, nameFromKey, previewKind, rebuildKey,
  safeContentType, sanitizeFileName, sanitizeFolderName,
} from '../keys.js';
import { audit, HttpError } from '../middleware/security.js';
import * as storages from '../storages.js';
import * as urlImport from '../url-import.js';

export const filesRouter = Router();

const canEdit = requireRole('editor');
const MAX_PARTS = 10_000; // ограничение S3
const MB = 1024 * 1024;
const LINK_TTLS = new Set([3600, 24 * 3600, 7 * 24 * 3600]);
const PREVIEW_TTL = 15 * 60;

function requireFolder(folder) {
  const value = folder ?? '';
  if (!isValidFolder(value)) throw new HttpError(400, 'Некорректный путь папки');
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

function requireUploadId(uploadId) {
  // eslint-disable-next-line no-control-regex
  if (typeof uploadId !== 'string' || !uploadId || uploadId.length > 1024 || /[\u0000-\u001f]/.test(uploadId)) {
    throw new HttpError(400, 'Некорректный uploadId');
  }
  return uploadId;
}

const { resolveRef, fileInfo } = storages;

// Подробности ошибок хранилищ (адреса, порты, коды) видит только администратор:
// обычным пользователям незачем знать внутреннюю инфраструктуру.
const publicWarnings = (req, warnings = []) => (hasRole(req.user, 'admin') ? warnings
  : warnings.map((w) => ({ storage: w.storage, error: 'нет связи с хранилищем' })));

// ---------- статистика ----------
filesRouter.get('/stats', async (req, res) => {
  const stats = await storages.getStats();
  if (hasRole(req.user, 'admin')) return res.json(stats);
  res.json({ ...stats, storages: stats.storages.map((s) => ({ ...s, error: s.error ? 'нет связи с хранилищем' : null })) });
});

// ---------- папки ----------

// GET /api/files?folder=a/b/&cursor=... — подпапки и файлы папки из всех хранилищ, новые сверху.
filesRouter.get('/files', async (req, res) => {
  const folder = requireFolder(typeof req.query.folder === 'string' ? req.query.folder : '');
  let cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  // Курсор — последний выданный ключ этой же папки (файл или подпапка).
  if (cursor !== undefined && (!cursor.startsWith(folder) || !(isValidKey(cursor) || isValidFolder(cursor)))) {
    throw new HttpError(400, 'Некорректный курсор');
  }
  if (cursor === '') cursor = undefined;
  const result = await storages.listFolder(folder, { cursor });
  res.json({ folder, ...result, warnings: publicWarnings(req, result.warnings) });
});

// POST /api/folders {parent, name} — создать папку (во всех хранилищах).
filesRouter.post('/folders', canEdit, async (req, res) => {
  const parent = requireFolder(req.body?.parent);
  const name = sanitizeFolderName(req.body?.name);
  if (!name) throw new HttpError(400, 'Введите название папки');
  const path = `${parent}${name}/`;
  if (!isValidFolder(path)) throw new HttpError(400, 'Слишком глубокая вложенность или длинный путь');
  const { warnings } = await storages.createFolder(path);
  storages.invalidateStats();
  audit(req, 'folder.create', { path });
  res.status(201).json({ folder: { path, name }, warnings: publicWarnings(req, warnings) });
});

// POST /api/folders/delete {path} — удалить папку со всем содержимым во всех хранилищах.
filesRouter.post('/folders/delete', canEdit, async (req, res) => {
  const path = requireFolder(req.body?.path);
  if (!path) throw new HttpError(400, 'Корневую папку удалить нельзя');
  const { deleted, warnings } = await storages.deleteFolder(path);
  storages.invalidateStats();
  audit(req, 'folder.delete', { path, deleted });
  res.json({ ok: true, deleted, warnings: publicWarnings(req, warnings) });
});

// ---------- загрузка ----------

// POST /api/uploads — начало загрузки. Сервер выбирает хранилище, ключ и способ загрузки.
filesRouter.post('/uploads', canEdit, async (req, res) => {
  const { name, size, type } = req.body ?? {};
  const folder = withSubfolders(requireFolder(req.body?.folder), req.body?.subfolders);
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Не указано имя файла');
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'Некорректный размер файла');
  if (size > config.limits.maxFileSize) {
    throw new HttpError(413, `Файл больше допустимого размера (${Math.round(config.limits.maxFileSize / MB)} МБ)`);
  }

  const st = await storages.pickForUpload(size);
  const rel = generateKey(name, folder);
  const key = fileInfo(st, rel, size).key;
  const contentType = safeContentType(type);

  if (size <= config.limits.multipartThreshold) {
    const { url, headers } = await st.presignPut(rel, contentType, size);
    return res.json({ mode: 'single', key, url, headers, storage: st.id, folder });
  }

  // Размер части — не меньше настроенного и такой, чтобы уложиться в 10 000 частей.
  const partSize = Math.max(config.limits.partSize, Math.ceil(size / MAX_PARTS / MB) * MB);
  const partCount = Math.ceil(size / partSize);
  const uploadId = await st.createMultipart(rel, contentType);
  res.json({ mode: 'multipart', key, uploadId, partSize, partCount, storage: st.id, folder });
});

// ---------- загрузка по ссылке (сервер скачивает файл сам) ----------
// POST /api/uploads/url {url, folder} → 202 {job}; статус — GET /api/uploads/url/:id
filesRouter.post('/uploads/url', canEdit, async (req, res) => {
  const folder = requireFolder(req.body?.folder);
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

// POST /api/uploads/parts — presigned URL для пачки частей multipart-загрузки.
filesRouter.post('/uploads/parts', canEdit, async (req, res) => {
  const { st, rel } = resolveRef(req.body?.key);
  const uploadId = requireUploadId(req.body?.uploadId);
  const numbers = req.body?.partNumbers;
  if (
    !Array.isArray(numbers) || numbers.length === 0 || numbers.length > 50 ||
    !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_PARTS)
  ) {
    throw new HttpError(400, 'Некорректный список частей');
  }
  const urls = {};
  for (const n of numbers) urls[n] = await st.presignPart(rel, uploadId, n);
  res.json({ urls });
});

// POST /api/uploads/complete — подтверждение загрузки и проверка лимита размера.
// Presigned PUT не ограничивает размер тела, поэтому лимит проверяется здесь,
// а превысившие его объекты сразу удаляются.
filesRouter.post('/uploads/complete', canEdit, async (req, res) => {
  const { st, rel } = resolveRef(req.body?.key);

  if (req.body?.uploadId === undefined) {
    const head = await st.headObject(rel);
    if (!head) throw new HttpError(404, 'Загруженный файл не найден в хранилище');
    if ((head.ContentLength ?? 0) > config.limits.maxFileSize) {
      await st.deleteObject(rel);
      throw new HttpError(413, 'Файл превышает допустимый размер и был удалён');
    }
    storages.noteUploaded(st.id, head.ContentLength ?? 0);
    storages.invalidateStats();
    audit(req, 'file.upload', { storage: st.id, key: rel, size: head.ContentLength ?? 0 });
    return res.json({ file: fileInfo(st, rel, head.ContentLength ?? 0, head.LastModified) });
  }

  const uploadId = requireUploadId(req.body.uploadId);
  const parts = await st.listAllParts(rel, uploadId);
  if (parts.length === 0) throw new HttpError(400, 'Ни одна часть файла не загружена');
  const total = parts.reduce((sum, p) => sum + p.Size, 0);
  if (total > config.limits.maxFileSize) {
    await st.abortMultipart(rel, uploadId);
    throw new HttpError(413, 'Файл превышает допустимый размер, загрузка отменена');
  }
  await st.completeMultipart(rel, uploadId, parts);
  storages.noteUploaded(st.id, total);
  storages.invalidateStats();
  audit(req, 'file.upload', { storage: st.id, key: rel, size: total });
  res.json({ file: fileInfo(st, rel, total) });
});

// POST /api/uploads/abort — отмена multipart-загрузки (освобождает место в бакете).
filesRouter.post('/uploads/abort', canEdit, async (req, res) => {
  const { st, rel } = resolveRef(req.body?.key);
  const uploadId = requireUploadId(req.body?.uploadId);
  try {
    await st.abortMultipart(rel, uploadId);
  } catch (err) {
    if (err.name !== 'NoSuchUpload') throw err;
  }
  res.json({ ok: true });
});

// ---------- файлы ----------

// POST /api/files/link — временная ссылка на скачивание напрямую из S3.
filesRouter.post('/files/link', async (req, res) => {
  const { st, rel } = resolveRef(req.body?.key);
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
    const preview = previewKind(nameFromKey(rel));
    if (preview?.kind !== 'image') continue;
    urls[key] = await st.presignGet(rel, PREVIEW_TTL, { contentType: preview.contentType });
  }
  res.json({ urls });
});

// POST /api/files/preview — короткоживущая inline-ссылка для предпросмотра.
// Тип ответа S3 задаёт сервер по белому списку расширений (см. keys.js).
filesRouter.post('/files/preview', async (req, res) => {
  const { st, rel } = resolveRef(req.body?.key);
  const head = await st.headObject(rel);
  if (!head) throw new HttpError(404, 'Файл не найден');
  const meta = {
    size: head.ContentLength ?? 0,
    contentType: head.ContentType ?? 'application/octet-stream',
    lastModified: head.LastModified?.toISOString() ?? null,
    storage: { id: st.id, name: st.name },
  };
  const preview = previewKind(nameFromKey(rel));
  if (!preview) return res.json({ kind: null, ...meta });
  // inline — только для PDF (его показывает iframe). Картинки, видео и аудио браузер отображает
  // в <img>/<video> и с «attachment», а при прямом открытии ссылки файл просто скачается:
  // загруженный SVG/HTML не сможет выполнить скрипт даже на домене хранилища.
  const url = await st.presignGet(rel, PREVIEW_TTL, { inline: preview.kind === 'pdf', contentType: preview.contentType });
  res.json({ kind: preview.kind, url, ...meta });
});

// POST /api/files/move {key, folder?, name?} — переименование и/или перемещение файла.
// В S3 нет операции rename: объект копируется под новым ключом внутри своего бакета,
// затем исходный удаляется. Ссылки, выданные на старый ключ, перестают работать.
filesRouter.post('/files/move', canEdit, async (req, res) => {
  const { st, rel } = resolveRef(req.body?.key);
  const folder = req.body?.folder === undefined ? folderFromKey(rel) : requireFolder(req.body.folder);
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

  // Класс хранения файла сохраняется (HeadObject не возвращает его для STANDARD).
  await st.copyObject(rel, target, size, head.ContentType, head.StorageClass ?? st.storageClass);
  await st.deleteObject(rel);
  storages.invalidateStats();
  audit(req, 'file.move', { storage: st.id, from: rel, to: target });
  res.json({ file: fileInfo(st, target, size), folder });
});

// POST /api/files/copy {key, folder?, name?} — копия файла (в том же бакете, байты не идут
// через VDS). Без имени в той же папке получается «имя (копия).ext».
filesRouter.post('/files/copy', canEdit, async (req, res) => {
  const { st, rel } = resolveRef(req.body?.key);
  const sourceFolder = folderFromKey(rel);
  const folder = req.body?.folder === undefined ? sourceFolder : requireFolder(req.body.folder);
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
  await st.copyObject(rel, target, size, head.ContentType, head.StorageClass ?? st.storageClass);
  storages.noteUploaded(st.id, size);
  storages.invalidateStats();
  audit(req, 'file.copy', { storage: st.id, from: rel, to: target });
  res.status(201).json({ file: fileInfo(st, target, size), folder });
});

// DELETE /api/files?key=... — удаление файла.
filesRouter.delete('/files', canEdit, async (req, res) => {
  const { st, rel } = resolveRef(req.query.key);
  await st.deleteObject(rel);
  storages.invalidateStats();
  audit(req, 'file.delete', { storage: st.id, key: rel });
  res.json({ ok: true });
});
