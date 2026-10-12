import { Router } from '../http.js';
import { requireRole } from '../auth.js';
import { config, onConfigChange } from '../config.js';
import {
  categoryOf, folderFromKey, folderToPrefix, generateKey, isValidFolder, isValidKey,
  nameFromKey, previewKind, rebuildKey, safeContentType, sanitizeFileName, sanitizeFolderName,
} from '../keys.js';
import { HttpError } from '../middleware/security.js';
import * as storage from '../s3.js';

export const filesRouter = Router();

const canEdit = requireRole('editor');
const MAX_PARTS = 10_000; // ограничение S3
const MB = 1024 * 1024;
const LINK_TTLS = new Set([3600, 24 * 3600, 7 * 24 * 3600]);
const PREVIEW_TTL = 15 * 60;

function requireKey(key) {
  if (!isValidKey(key)) throw new HttpError(400, 'Некорректный ключ файла');
  return key;
}

function requireFolder(folder) {
  const value = folder ?? '';
  if (!isValidFolder(value)) throw new HttpError(400, 'Некорректный путь папки');
  return value;
}

function requireUploadId(uploadId) {
  // eslint-disable-next-line no-control-regex
  if (typeof uploadId !== 'string' || !uploadId || uploadId.length > 1024 || /[\u0000-\u001f]/.test(uploadId)) {
    throw new HttpError(400, 'Некорректный uploadId');
  }
  return uploadId;
}

function fileInfo(key, size, lastModified) {
  return { key, name: nameFromKey(key), size, lastModified: (lastModified ?? new Date()).toISOString() };
}

// ---------- статистика (кэш на 30 с, сбрасывается при изменениях) ----------
const STATS_TTL = 30_000;
const STATS_MAX_OBJECTS = 20_000;
let statsCache = null;
let statsGeneration = 0;
// Сбрасывается ПОСЛЕ успешного изменения в S3. Счётчик поколений не даёт сохранить в кэш
// результат подсчёта, который начался до изменения и закончился после.
const invalidateStats = () => { statsCache = null; statsGeneration++; };
// Другой бакет или папка в бакете — другая статистика.
onConfigChange((changed) => { if (changed.some((k) => k.startsWith('S3_'))) invalidateStats(); });

// ISO-даты сравниваются как строки — без localeCompare (он подгружает ICU).
const byDateDesc = (a, b) => ((b.lastModified ?? '') > (a.lastModified ?? '') ? 1 : -1);

async function computeStats() {
  const categories = Object.fromEntries(
    ['image', 'video', 'audio', 'document', 'archive', 'other'].map((c) => [c, { count: 0, size: 0 }]),
  );
  const folders = new Set();
  let files = 0;
  let size = 0;
  let recent = [];
  const complete = await storage.forEachObject(config.s3.prefix, (o) => {
    if (!isValidKey(o.Key)) {
      if (o.Key.endsWith('/') && o.Key !== config.s3.prefix) folders.add(o.Key);
      return;
    }
    const file = { key: o.Key, name: nameFromKey(o.Key), size: o.Size ?? 0,
      lastModified: o.LastModified?.toISOString() ?? null, folder: folderFromKey(o.Key) };
    files += 1;
    size += file.size;
    const cat = categories[categoryOf(file.name)];
    cat.count += 1;
    cat.size += file.size;
    // Папки, в которых есть файлы, но нет маркера.
    for (let f = file.folder; f; f = f.slice(0, f.slice(0, -1).lastIndexOf('/') + 1)) folders.add(folderToPrefix(f));
    recent.push(file);
    if (recent.length > 64) recent = recent.sort(byDateDesc).slice(0, 8);
  }, { max: STATS_MAX_OBJECTS });
  recent = recent.sort(byDateDesc).slice(0, 8);
  return { files, folders: folders.size, size, categories, recent, complete };
}

filesRouter.get('/stats', async (req, res) => {
  if (statsCache && Date.now() - statsCache.at <= STATS_TTL) return res.json(statsCache.data);
  const generation = statsGeneration;
  const data = await computeStats();
  if (generation === statsGeneration) statsCache = { at: Date.now(), data };
  res.json(data);
});

// ---------- папки ----------

// GET /api/files?folder=a/b/&cursor=... — подпапки и файлы папки, новые файлы сверху.
filesRouter.get('/files', async (req, res) => {
  const folder = requireFolder(typeof req.query.folder === 'string' ? req.query.folder : '');
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.slice(0, 2048) : undefined;
  res.json({ folder, ...(await storage.listFolder(folder, { cursor })) });
});

// POST /api/folders {parent, name} — создать папку.
filesRouter.post('/folders', canEdit, async (req, res) => {
  const parent = requireFolder(req.body?.parent);
  const name = sanitizeFolderName(req.body?.name);
  if (!name) throw new HttpError(400, 'Введите название папки');
  const path = `${parent}${name}/`;
  if (!isValidFolder(path)) throw new HttpError(400, 'Слишком глубокая вложенность или длинный путь');
  await storage.putFolderMarker(path);
  invalidateStats();
  res.status(201).json({ folder: { path, name } });
});

// POST /api/folders/delete {path} — удалить папку со всем содержимым.
filesRouter.post('/folders/delete', canEdit, async (req, res) => {
  const path = requireFolder(req.body?.path);
  if (!path) throw new HttpError(400, 'Корневую папку удалить нельзя');
  // Удаляем пачками по 1000 по мере обхода — список ключей не копится в памяти.
  let batch = [];
  let deleted = 0;
  const flush = async () => {
    if (!batch.length) return;
    await storage.deleteMany(batch);
    deleted += batch.length;
    batch = [];
  };
  await storage.forEachObject(folderToPrefix(path), async (o) => {
    batch.push(o.Key);
    if (batch.length >= 1000) await flush();
  });
  await flush();
  invalidateStats();
  res.json({ ok: true, deleted });
});

// ---------- загрузка ----------

// POST /api/uploads — начало загрузки. Сервер сам выбирает ключ и способ загрузки.
filesRouter.post('/uploads', canEdit, async (req, res) => {
  const { name, size, type } = req.body ?? {};
  const folder = requireFolder(req.body?.folder);
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Не указано имя файла');
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'Некорректный размер файла');
  if (size > config.limits.maxFileSize) {
    throw new HttpError(413, `Файл больше допустимого размера (${Math.round(config.limits.maxFileSize / MB)} МБ)`);
  }

  const key = generateKey(name, folder);
  const contentType = safeContentType(type);

  if (size <= config.limits.multipartThreshold) {
    const url = await storage.presignPut(key, contentType);
    return res.json({ mode: 'single', key, url, headers: { 'Content-Type': contentType } });
  }

  // Размер части — не меньше настроенного и такой, чтобы уложиться в 10 000 частей.
  const partSize = Math.max(config.limits.partSize, Math.ceil(size / MAX_PARTS / MB) * MB);
  const partCount = Math.ceil(size / partSize);
  const uploadId = await storage.createMultipart(key, contentType);
  res.json({ mode: 'multipart', key, uploadId, partSize, partCount });
});

// POST /api/uploads/parts — presigned URL для пачки частей multipart-загрузки.
filesRouter.post('/uploads/parts', canEdit, async (req, res) => {
  const key = requireKey(req.body?.key);
  const uploadId = requireUploadId(req.body?.uploadId);
  const numbers = req.body?.partNumbers;
  if (
    !Array.isArray(numbers) || numbers.length === 0 || numbers.length > 50 ||
    !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_PARTS)
  ) {
    throw new HttpError(400, 'Некорректный список частей');
  }
  const urls = {};
  for (const n of numbers) urls[n] = await storage.presignPart(key, uploadId, n);
  res.json({ urls });
});

// POST /api/uploads/complete — подтверждение загрузки и проверка лимита размера.
// Presigned PUT не ограничивает размер тела, поэтому лимит проверяется здесь,
// а превысившие его объекты сразу удаляются.
filesRouter.post('/uploads/complete', canEdit, async (req, res) => {
  const key = requireKey(req.body?.key);

  if (req.body?.uploadId === undefined) {
    const head = await storage.headObject(key);
    if (!head) throw new HttpError(404, 'Загруженный файл не найден в хранилище');
    if ((head.ContentLength ?? 0) > config.limits.maxFileSize) {
      await storage.deleteObject(key);
      throw new HttpError(413, 'Файл превышает допустимый размер и был удалён');
    }
    invalidateStats();
    return res.json({ file: fileInfo(key, head.ContentLength ?? 0, head.LastModified) });
  }

  const uploadId = requireUploadId(req.body.uploadId);
  const parts = await storage.listAllParts(key, uploadId);
  if (parts.length === 0) throw new HttpError(400, 'Ни одна часть файла не загружена');
  const total = parts.reduce((sum, p) => sum + p.Size, 0);
  if (total > config.limits.maxFileSize) {
    await storage.abortMultipart(key, uploadId);
    throw new HttpError(413, 'Файл превышает допустимый размер, загрузка отменена');
  }
  await storage.completeMultipart(key, uploadId, parts);
  invalidateStats();
  res.json({ file: fileInfo(key, total) });
});

// POST /api/uploads/abort — отмена multipart-загрузки (освобождает место в бакете).
filesRouter.post('/uploads/abort', canEdit, async (req, res) => {
  const key = requireKey(req.body?.key);
  const uploadId = requireUploadId(req.body?.uploadId);
  try {
    await storage.abortMultipart(key, uploadId);
  } catch (err) {
    if (err.name !== 'NoSuchUpload') throw err;
  }
  res.json({ ok: true });
});

// ---------- файлы ----------

// POST /api/files/link — временная ссылка на скачивание напрямую из S3.
filesRouter.post('/files/link', async (req, res) => {
  const key = requireKey(req.body?.key);
  const ttl = req.body?.ttl ?? 24 * 3600;
  if (!LINK_TTLS.has(ttl) || ttl > config.limits.maxDownloadTtlSec) {
    throw new HttpError(400, 'Недопустимый срок действия ссылки');
  }
  if (!(await storage.headObject(key))) throw new HttpError(404, 'Файл не найден');
  const url = await storage.presignGet(key, ttl);
  res.json({ url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() });
});

// POST /api/files/preview — короткоживущая inline-ссылка для предпросмотра.
// Тип ответа S3 задаёт сервер по белому списку расширений (см. keys.js).
filesRouter.post('/files/preview', async (req, res) => {
  const key = requireKey(req.body?.key);
  const head = await storage.headObject(key);
  if (!head) throw new HttpError(404, 'Файл не найден');
  const meta = {
    size: head.ContentLength ?? 0,
    contentType: head.ContentType ?? 'application/octet-stream',
    lastModified: head.LastModified?.toISOString() ?? null,
  };
  const preview = previewKind(nameFromKey(key));
  if (!preview) return res.json({ kind: null, ...meta });
  const url = await storage.presignGet(key, PREVIEW_TTL, { inline: true, contentType: preview.contentType });
  res.json({ kind: preview.kind, url, ...meta });
});

// POST /api/files/move {key, folder?, name?} — переименование и/или перемещение файла.
// В S3 нет операции rename: объект копируется под новым ключом (внутри хранилища),
// затем исходный удаляется. Ссылки, выданные на старый ключ, перестают работать.
filesRouter.post('/files/move', canEdit, async (req, res) => {
  const key = requireKey(req.body?.key);
  const folder = req.body?.folder === undefined ? folderFromKey(key) : requireFolder(req.body.folder);
  let name = nameFromKey(key);
  if (req.body?.name !== undefined) {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) throw new HttpError(400, 'Введите имя файла');
    if (req.body.name.length > 500) throw new HttpError(400, 'Слишком длинное имя файла');
    name = sanitizeFileName(req.body.name);
  }
  const target = rebuildKey(key, { folder, name });
  if (!isValidKey(target)) throw new HttpError(400, 'Слишком длинный путь или имя файла');

  const head = await storage.headObject(key);
  if (!head) throw new HttpError(404, 'Файл не найден');
  const size = head.ContentLength ?? 0;
  if (target === key) return res.json({ file: fileInfo(key, size, head.LastModified), folder });

  await storage.copyObject(key, target, size, head.ContentType);
  await storage.deleteObject(key);
  invalidateStats();
  res.json({ file: fileInfo(target, size), folder });
});

// DELETE /api/files?key=... — удаление файла.
filesRouter.delete('/files', canEdit, async (req, res) => {
  const key = requireKey(req.query.key);
  await storage.deleteObject(key);
  invalidateStats();
  res.json({ ok: true });
});
