// Загрузка файла напрямую в S3 — общая логика для вошедших пользователей и для гостевой
// загрузки по ссылке «для загрузки к вам» (shares.js): выбор хранилища, ключ, presigned
// PUT или multipart, завершение с проверкой размера.
import { config } from './config.js';
import { generateKey, safeContentType } from './keys.js';
import * as storages from './storages.js';

const MAX_PARTS = 10_000; // ограничение S3
const MB = 1024 * 1024;

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * @param {{ name: string, size: number, type?: string, folder: string, maxSize?: number }} p
 */
export async function planUpload({ name, size, type, folder, maxSize = config.limits.maxFileSize }) {
  if (typeof name !== 'string' || !name.trim()) throw fail(400, 'Не указано имя файла');
  if (!Number.isSafeInteger(size) || size < 0) throw fail(400, 'Некорректный размер файла');
  if (size > maxSize) throw fail(413, `Файл больше допустимого размера (${Math.round(maxSize / MB)} МБ)`);

  const st = await storages.pickForUpload(size);
  const rel = generateKey(name, folder);
  const key = storages.fileInfo(st, rel, size).key;
  const contentType = safeContentType(type);

  if (size <= config.limits.multipartThreshold) {
    const { url, headers } = await st.presignPut(rel, contentType, size);
    return { mode: 'single', key, url, headers, storage: st.id, folder };
  }
  // Размер части — не меньше настроенного и такой, чтобы уложиться в 10 000 частей.
  const partSize = Math.max(config.limits.partSize, Math.ceil(size / MAX_PARTS / MB) * MB);
  const partCount = Math.ceil(size / partSize);
  const uploadId = await st.createMultipart(rel, contentType);
  return { mode: 'multipart', key, uploadId, partSize, partCount, storage: st.id, folder };
}

export async function presignParts(key, uploadId, numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0 || numbers.length > 50 ||
      !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_PARTS)) {
    throw fail(400, 'Некорректный список частей');
  }
  const { st, rel } = storages.resolveRef(key);
  const urls = {};
  for (const n of numbers) urls[n] = await st.presignPart(rel, uploadId, n);
  return urls;
}

/** Завершает загрузку; файл больше maxSize удаляется. @returns {{ file, st, rel, size }} */
export async function completeUpload(key, uploadId, { maxSize = config.limits.maxFileSize } = {}) {
  const { st, rel } = storages.resolveRef(key);
  let size;
  let lastModified;
  if (uploadId === undefined) {
    const head = await st.headObject(rel);
    if (!head) throw fail(404, 'Загруженный файл не найден в хранилище');
    size = head.ContentLength ?? 0;
    lastModified = head.LastModified;
    if (size > maxSize) {
      await st.deleteObject(rel);
      throw fail(413, 'Файл превышает допустимый размер и был удалён');
    }
  } else {
    const parts = await st.listAllParts(rel, uploadId);
    if (parts.length === 0) throw fail(400, 'Ни одна часть файла не загружена');
    size = parts.reduce((sum, p) => sum + p.Size, 0);
    if (size > maxSize) {
      await st.abortMultipart(rel, uploadId);
      throw fail(413, 'Файл превышает допустимый размер, загрузка отменена');
    }
    await st.completeMultipart(rel, uploadId, parts);
  }
  storages.noteUploaded(st.id, size);
  storages.invalidateStats();
  return { file: storages.fileInfo(st, rel, size, lastModified), st, rel, size };
}

/** Уже загруженные части незавершённой multipart-загрузки (продолжение после перезагрузки страницы). */
export async function uploadedParts(key, uploadId) {
  const { st, rel } = storages.resolveRef(key);
  try {
    const parts = await st.listAllParts(rel, uploadId);
    return parts.map((p) => ({ n: p.PartNumber, size: p.Size }));
  } catch (err) {
    if (err.name === 'NoSuchUpload' || err.$metadata?.httpStatusCode === 404) {
      throw fail(410, 'Загрузку уже не продолжить: она отменена или удалена хранилищем');
    }
    throw err;
  }
}

export async function abortUpload(key, uploadId) {
  const { st, rel } = storages.resolveRef(key);
  try {
    await st.abortMultipart(rel, uploadId);
  } catch (err) {
    if (err.name !== 'NoSuchUpload') throw err;
  }
}
