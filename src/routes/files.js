import { Router } from 'express';
import { config } from '../config.js';
import { generateKey, isValidKey, nameFromKey, safeContentType } from '../keys.js';
import { HttpError } from '../middleware/security.js';
import * as storage from '../s3.js';

export const filesRouter = Router();

const { maxFileSize, multipartThreshold, partSize: minPartSize } = config.limits;
const MAX_PARTS = 10_000; // ограничение S3
const MB = 1024 * 1024;
const LINK_TTLS = new Set([3600, 24 * 3600, 7 * 24 * 3600]);

function requireKey(key) {
  if (!isValidKey(key)) throw new HttpError(400, 'Некорректный ключ файла');
  return key;
}

function requireUploadId(uploadId) {
  if (typeof uploadId !== 'string' || !uploadId || uploadId.length > 1024 || /[\u0000-\u001f]/.test(uploadId)) {
    throw new HttpError(400, 'Некорректный uploadId');
  }
  return uploadId;
}

function fileInfo(key, size, lastModified) {
  return { key, name: nameFromKey(key), size, lastModified: (lastModified ?? new Date()).toISOString() };
}

// GET /api/files?cursor=... — список файлов, новые сверху, постранично.
filesRouter.get('/files', async (req, res) => {
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.slice(0, 2048) : undefined;
  res.json(await storage.listFiles({ cursor, limit: 100 }));
});

// POST /api/uploads — начало загрузки. Сервер сам выбирает ключ и способ загрузки.
filesRouter.post('/uploads', async (req, res) => {
  const { name, size, type } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Не указано имя файла');
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'Некорректный размер файла');
  if (size > maxFileSize) {
    throw new HttpError(413, `Файл больше допустимого размера (${Math.round(maxFileSize / MB)} МБ)`);
  }

  const key = generateKey(name);
  const contentType = safeContentType(type);

  if (size <= multipartThreshold) {
    const url = await storage.presignPut(key, contentType);
    return res.json({ mode: 'single', key, url, headers: { 'Content-Type': contentType } });
  }

  // Размер части — не меньше настроенного и такой, чтобы уложиться в 10 000 частей.
  const partSize = Math.max(minPartSize, Math.ceil(size / MAX_PARTS / MB) * MB);
  const partCount = Math.ceil(size / partSize);
  const uploadId = await storage.createMultipart(key, contentType);
  res.json({ mode: 'multipart', key, uploadId, partSize, partCount });
});

// POST /api/uploads/parts — presigned URL для пачки частей multipart-загрузки.
filesRouter.post('/uploads/parts', async (req, res) => {
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
filesRouter.post('/uploads/complete', async (req, res) => {
  const key = requireKey(req.body?.key);

  if (req.body?.uploadId === undefined) {
    const head = await storage.headObject(key);
    if (!head) throw new HttpError(404, 'Загруженный файл не найден в хранилище');
    if ((head.ContentLength ?? 0) > maxFileSize) {
      await storage.deleteObject(key);
      throw new HttpError(413, 'Файл превышает допустимый размер и был удалён');
    }
    return res.json({ file: fileInfo(key, head.ContentLength ?? 0, head.LastModified) });
  }

  const uploadId = requireUploadId(req.body.uploadId);
  const parts = await storage.listAllParts(key, uploadId);
  if (parts.length === 0) throw new HttpError(400, 'Ни одна часть файла не загружена');
  const total = parts.reduce((sum, p) => sum + p.Size, 0);
  if (total > maxFileSize) {
    await storage.abortMultipart(key, uploadId);
    throw new HttpError(413, 'Файл превышает допустимый размер, загрузка отменена');
  }
  await storage.completeMultipart(key, uploadId, parts);
  res.json({ file: fileInfo(key, total) });
});

// POST /api/uploads/abort — отмена multipart-загрузки (освобождает место в бакете).
filesRouter.post('/uploads/abort', async (req, res) => {
  const key = requireKey(req.body?.key);
  const uploadId = requireUploadId(req.body?.uploadId);
  try {
    await storage.abortMultipart(key, uploadId);
  } catch (err) {
    if (err.name !== 'NoSuchUpload') throw err;
  }
  res.json({ ok: true });
});

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

// DELETE /api/files?key=... — удаление файла.
filesRouter.delete('/files', async (req, res) => {
  const key = requireKey(req.query.key);
  await storage.deleteObject(key);
  res.json({ ok: true });
});
