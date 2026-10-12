// Прямая загрузка файла в S3 по presigned URL.
// - Небольшие файлы: один PUT.
// - Крупные: multipart-загрузка частями, параллельно, с повтором упавших частей.
// Прогресс считается по XHR (fetch пока не умеет отдавать прогресс отправки).
import { api } from './api.js';

const PART_CONCURRENCY = 3;
const PART_RETRIES = 3;
const URL_BATCH = 20;

export class UploadCancelled extends Error {
  constructor() {
    super('Загрузка отменена');
  }
}

function putBlob(url, blob, headers, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCancelled());
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(blob.size);
        resolve();
      } else {
        reject(new Error(`Хранилище S3 ответило ошибкой ${xhr.status}`));
      }
    };
    // status 0 почти всегда означает, что браузер заблокировал запрос по CORS.
    xhr.onerror = () => reject(new Error('Нет ответа от S3 (проверьте CORS бакета и соединение)'));
    xhr.ontimeout = () => reject(new Error('Превышено время ожидания S3'));
    const onAbort = () => xhr.abort();
    xhr.onabort = () => reject(new UploadCancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', onAbort);
    xhr.send(blob);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {File} file
 * @param {{ onProgress: (loaded: number, total: number) => void, signal: AbortSignal }} opts
 * @returns {Promise<{key: string, name: string, size: number, lastModified: string}>}
 */
export async function uploadFile(file, { onProgress, signal }) {
  const plan = await api.startUpload(file);

  if (plan.mode === 'single') {
    await putBlob(plan.url, file, plan.headers, (loaded) => onProgress(loaded, file.size), signal);
    return (await api.completeUpload(plan.key)).file;
  }

  const { key, uploadId, partSize, partCount } = plan;
  const loadedByPart = new Array(partCount + 1).fill(0);
  const report = () => onProgress(loadedByPart.reduce((a, b) => a + b, 0), file.size);
  const urls = new Map();
  let nextPart = 1;
  // Внутренний сигнал: ошибка одной части останавливает остальные воркеры.
  const local = new AbortController();
  if (signal.aborted) local.abort();
  signal.addEventListener('abort', () => local.abort(), { once: true });

  // Ссылки запрашиваются пачками; в Map лежат промисы, чтобы параллельные
  // воркеры не запрашивали одни и те же части повторно.
  function urlFor(n) {
    if (!urls.has(n)) {
      const batch = [];
      for (let i = n; i < n + URL_BATCH && i <= partCount; i++) if (!urls.has(i)) batch.push(i);
      const req = api.partUrls(key, uploadId, batch);
      for (const i of batch) urls.set(i, req.then((res) => res.urls[i]));
    }
    return urls.get(n);
  }

  async function uploadPart(n) {
    const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
    for (let attempt = 1; ; attempt++) {
      try {
        const url = await urlFor(n);
        await putBlob(url, blob, null, (loaded) => { loadedByPart[n] = loaded; report(); }, local.signal);
        urls.delete(n);
        return;
      } catch (err) {
        urls.delete(n);
        if (err instanceof UploadCancelled || attempt >= PART_RETRIES) throw err;
        loadedByPart[n] = 0;
        report();
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  async function worker() {
    try {
      while (nextPart <= partCount) {
        if (local.signal.aborted) throw new UploadCancelled();
        await uploadPart(nextPart++);
      }
    } catch (err) {
      local.abort();
      throw err;
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, worker));
    return (await api.completeUpload(key, uploadId)).file;
  } catch (err) {
    // Незавершённая multipart-загрузка занимает место в бакете — отменяем её.
    api.abortUpload(key, uploadId).catch(() => {});
    throw err;
  }
}
