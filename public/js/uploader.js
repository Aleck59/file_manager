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

// Пауза: запросы в полёте прерываются, загруженные части multipart остаются в S3.
class UploadPaused extends Error {}

/**
 * Управление загрузкой: пауза/продолжение. Один объект на файл.
 */
export class UploadControl {
  constructor() {
    this.paused = false;
    this.pauseCtl = new AbortController();
    this.waiters = [];
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pauseCtl.abort();
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pauseCtl = new AbortController();
    this.waiters.splice(0).forEach((fn) => fn());
  }
  /** Дождаться снятия паузы (или сразу, если её нет). */
  untilResumed(signal) {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      signal.addEventListener('abort', () => reject(new UploadCancelled()), { once: true });
    });
  }
}

// ---------- ограничение скорости ----------
// Браузер не умеет замедлять один запрос, поэтому ограничение — среднее: перед каждой
// частью (или файлом) ждём, сколько требует заданная скорость. Общее для всех загрузок.
let nextSlot = 0;
export const speedLimit = () => Number(localStorage.getItem('fm-upload-limit') || 0) * 1024 * 1024; // байт/с, 0 — без ограничения
async function throttle(bytes, signal) {
  const limit = speedLimit();
  if (!limit) return;
  const now = performance.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + (bytes / limit) * 1000;
  if (start > now) await abortableSleep(start - now, signal);
}
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new UploadCancelled()); }, { once: true });
  });
}

function putBlob(url, blob, headers, onProgress, signal, pauseSignal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCancelled());
    if (pauseSignal?.aborted) return reject(new UploadPaused());
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(blob.size);
        resolve();
      } else {
        // Код ошибки S3 из XML-ответа (AccessDenied, SignatureDoesNotMatch, InvalidStorageClass…).
        const code = xhr.responseText?.match(/<Code>([^<]+)<\/Code>/)?.[1];
        reject(new Error(`Хранилище отклонило загрузку: ${code ?? `HTTP ${xhr.status}`}. Подробности — Настройки → Хранилища → «Проверить загрузку из браузера»`));
      }
    };
    // status 0 почти всегда означает, что браузер заблокировал запрос по CORS.
    // status 0: браузер не получил ответа. Чаще всего это CORS бакета, реже — смешанный
    // контент (сайт https, хранилище http) или обрыв сети.
    xhr.onerror = () => reject(new Error(location.protocol === 'https:' && url.startsWith('http:')
      ? 'Браузер блокирует хранилище по http на сайте https — укажите endpoint с https://'
      : 'Нет ответа от хранилища: скорее всего, у бакета не настроен CORS. Настройки → Хранилища → «Проверить загрузку из браузера»'));
    xhr.ontimeout = () => reject(new Error('Превышено время ожидания S3'));
    const onAbort = () => xhr.abort();
    xhr.onabort = () => reject(signal.aborted ? new UploadCancelled() : new UploadPaused());
    signal.addEventListener('abort', onAbort, { once: true });
    pauseSignal?.addEventListener('abort', onAbort, { once: true });
    xhr.onloadend = () => {
      signal.removeEventListener('abort', onAbort);
      pauseSignal?.removeEventListener('abort', onAbort);
    };
    xhr.send(blob);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {File} file
 * @param {{ folder?: string, subfolders?: string[], onProgress: (loaded: number, total: number) => void, signal: AbortSignal }} opts
 * @returns {Promise<{file: {key: string, name: string, size: number, lastModified: string}, folder: string}>}
 */
// client — набор методов API (по умолчанию — обычный; для гостевой загрузки по ссылке — свой).
export async function uploadFile(file, { folder = '', subfolders, onProgress, signal, control = new UploadControl(), client = api }) {
  let plan = await client.startUpload(file, folder, subfolders);
  // Итоговая папка (с подпапками при загрузке папки целиком) — её определяет сервер.
  const target = plan.folder ?? folder;

  if (plan.mode === 'single') {
    for (;;) {
      await control.untilResumed(signal);
      await throttle(file.size, signal);
      try {
        await putBlob(plan.url, file, plan.headers, (loaded) => onProgress(loaded, file.size), signal, control.pauseCtl.signal);
        break;
      } catch (err) {
        if (!(err instanceof UploadPaused)) throw err;
        onProgress(0, file.size);
        // После паузы ссылка могла истечь — берём новую (файл ещё не загружен, ключ не важен).
        await control.untilResumed(signal);
        plan = await client.startUpload(file, folder, subfolders);
      }
    }
    return { file: (await client.completeUpload(plan.key)).file, folder: target };
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
      const req = client.partUrls(key, uploadId, batch);
      for (const i of batch) urls.set(i, req.then((res) => res.urls[i]));
    }
    return urls.get(n);
  }

  async function uploadPart(n) {
    const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
    for (let attempt = 1; ; attempt++) {
      try {
        await control.untilResumed(local.signal);
        await throttle(blob.size, local.signal);
        const url = await urlFor(n);
        await putBlob(url, blob, null, (loaded) => { loadedByPart[n] = loaded; report(); }, local.signal, control.pauseCtl.signal);
        urls.delete(n);
        return;
      } catch (err) {
        // Пауза: часть начнётся заново после продолжения (ссылки берутся новые), попытка не считается.
        if (err instanceof UploadPaused) {
          urls.clear();
          loadedByPart[n] = 0;
          report();
          attempt--;
          continue;
        }
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
    // С ограничением скорости части идут по одной — так среднее точнее.
    const concurrency = speedLimit() ? 1 : PART_CONCURRENCY;
    await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, worker));
    return { file: (await client.completeUpload(key, uploadId)).file, folder: target };
  } catch (err) {
    // Незавершённая multipart-загрузка занимает место в бакете — отменяем её.
    client.abortUpload(key, uploadId).catch(() => {});
    throw err;
  }
}
