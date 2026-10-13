// Загрузка файла по ссылке: сервер сам скачивает файл и потоком кладёт его в S3.
//
// Защита от SSRF (запросов к внутренней сети через наш сервер):
// - только http/https, без логина/пароля в адресе;
// - имя хоста разрешается в IP заранее; если ХОТЯ БЫ ОДИН адрес частный, локальный,
//   служебный или зарезервированный — отказ (в т.ч. IPv4 внутри IPv6 ::ffff:a.b.c.d);
// - соединение идёт на тот самый проверенный IP (lookup подменён) — подмена DNS между
//   проверкой и запросом (DNS rebinding) не сработает;
// - редиректы (до 5) проверяются заново на каждом шаге.
// Память: файл не держится целиком — части по 5 МБ уходят в S3 (multipart) по мере
// скачивания; поток сам ждёт, пока часть отправится (обратное давление).
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { generateKey, isValidFolder, safeContentType, sanitizeFileName } from './keys.js';
import * as storages from './storages.js';

const require = createRequire(import.meta.url);
const httpLib = require('node:http');
const httpsLib = require('node:https');

const PART = 5 * 1024 * 1024; // минимальная часть S3
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;
const MAX_ACTIVE = 2; // одновременно на весь сервер — бережём память и канал
const KEEP_FINISHED_MS = 10 * 60_000;

// ---------- проверка адресов ----------
const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(net6, prefix, 'ipv6');

/** true, если адрес нельзя запрашивать с сервера. */
export function isForbiddenAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isForbiddenAddress(mapped[1]);
    // ::ffff:7f00:1 — тот же IPv4 в шестнадцатеричной записи
    const hex = address.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const a = parseInt(hex[1], 16);
      const b = parseInt(hex[2], 16);
      return isForbiddenAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
  }
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function parseImportUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw Object.assign(new Error('Некорректная ссылка'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Поддерживаются только ссылки http и https'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('Ссылки с логином и паролем не поддерживаются'), { status: 400 });
  if (u.href.length > 4096) throw Object.assign(new Error('Слишком длинная ссылка'), { status: 400 });
  return u;
}

async function resolvePublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const list = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!list.length) throw new Error('Не удалось найти сервер по ссылке');
  if (list.some((a) => isForbiddenAddress(a.address))) {
    throw Object.assign(new Error('Ссылка ведёт во внутреннюю сеть — такие адреса запрещены'), { status: 400 });
  }
  return list[0];
}

/** GET с проверкой адреса на каждом шаге редиректа. Возвращает ответ (поток). */
async function fetchPublic(url, signal, redirects = 0) {
  const target = await resolvePublic(url.hostname);
  const lib = url.protocol === 'https:' ? httpsLib : httpLib;
  const res = await new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET',
      headers: { 'user-agent': 'file-manager/1.0 (+import by url)', accept: '*/*' },
      // Соединение — только на проверенный адрес (защита от DNS rebinding).
      lookup: (_host, opts, cb) => (opts?.all ? cb(null, [target]) : cb(null, target.address, target.family)),
      timeout: TIMEOUT_MS,
      signal,
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('Сервер по ссылке не отвечает')));
    req.on('error', reject);
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
    res.resume();
    if (redirects >= MAX_REDIRECTS) throw new Error('Слишком много перенаправлений');
    return fetchPublic(parseImportUrl(new URL(res.headers.location, url).href), signal, redirects + 1);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`Сервер по ссылке ответил ${res.statusCode}`);
  }
  return { res, finalUrl: url };
}

function fileNameFrom(res, url) {
  const cd = res.headers['content-disposition'] ?? '';
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* ниже */ } }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/);
  if (plain) return plain[1].trim();
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (last) { try { return decodeURIComponent(last); } catch { return last; } }
  return 'download';
}

// ---------- задания ----------
const jobs = new Map(); // id → job

function publicJob(job) {
  const { id, name, folder, size, loaded, status, error, file, startedAt } = job;
  return { id, name, folder, size, loaded, status, error, file, startedAt };
}

export function getJob(id, user) {
  const job = jobs.get(id);
  return job && job.user === user ? publicJob(job) : null;
}

export function cancelJob(id, user) {
  const job = jobs.get(id);
  if (!job || job.user !== user) return false;
  job.controller.abort();
  return true;
}

/**
 * Запускает фоновую загрузку. Возвращает описание задания (статус — через getJob).
 * @param {{ url: string, folder: string, user: string, onDone?: (job) => void }} opts
 */
export async function startImport({ url: raw, folder, user, onDone }) {
  if (!isValidFolder(folder)) throw Object.assign(new Error('Некорректный путь папки'), { status: 400 });
  const url = parseImportUrl(raw);
  const running = [...jobs.values()].filter((j) => j.status === 'running');
  if (running.length >= MAX_ACTIVE) throw Object.assign(new Error('Сервер уже скачивает файлы по ссылкам — попробуйте через минуту'), { status: 429 });
  if (running.some((j) => j.user === user)) throw Object.assign(new Error('Дождитесь окончания предыдущей загрузки по ссылке'), { status: 429 });
  await resolvePublic(url.hostname); // быстрый отказ до создания задания

  const job = {
    id: crypto.randomBytes(9).toString('base64url'), user, folder, host: url.host,
    name: sanitizeFileName(fileNameFrom({ headers: {} }, url)), size: null, loaded: 0,
    status: 'running', error: null, file: null, startedAt: new Date().toISOString(), controller: new AbortController(),
  };
  jobs.set(job.id, job);
  run(job, url).then(() => onDone?.(job), () => onDone?.(job));
  return publicJob(job);
}

async function run(job, url) {
  let st;
  let rel;
  let uploadId = null;
  const signal = job.controller.signal;
  try {
    const { res, finalUrl } = await fetchPublic(url, signal);
    const length = Number(res.headers['content-length']);
    if (Number.isFinite(length) && length > config.limits.maxFileSize) {
      res.destroy();
      throw new Error(`Файл больше допустимого размера (${Math.round(config.limits.maxFileSize / 1024 / 1024)} МБ)`);
    }
    job.size = Number.isFinite(length) ? length : null;
    job.name = sanitizeFileName(fileNameFrom(res, finalUrl));
    const contentType = safeContentType(String(res.headers['content-type'] ?? '').split(';')[0]);
    st = await storages.pickForUpload(job.size ?? 0);
    rel = generateKey(job.name, job.folder);

    const parts = [];
    let chunks = [];
    let buffered = 0;
    const flush = async (final) => {
      const body = Buffer.concat(chunks, buffered);
      chunks = [];
      buffered = 0;
      if (!uploadId) {
        if (final) return st.putBuffer(rel, body, contentType); // небольшой файл — одним запросом
        uploadId = await st.createMultipart(rel, contentType);
      }
      if (final && !body.length && parts.length) return;
      const n = parts.length + 1;
      parts.push({ PartNumber: n, ETag: await st.uploadPartBuffer(rel, uploadId, n, body) });
    };
    res.setTimeout(TIMEOUT_MS, () => res.destroy(new Error('Скачивание прервалось: сервер по ссылке замолчал')));
    for await (const chunk of res) {
      job.loaded += chunk.length;
      if (job.loaded > config.limits.maxFileSize) {
        res.destroy();
        throw new Error(`Файл больше допустимого размера (${Math.round(config.limits.maxFileSize / 1024 / 1024)} МБ)`);
      }
      chunks.push(chunk);
      buffered += chunk.length;
      if (buffered >= PART) await flush(false);
    }
    if (signal.aborted) throw new Error('Отменено');
    await flush(true);
    if (uploadId) await st.completeMultipart(rel, uploadId, parts);
    storages.noteUploaded(st.id, job.loaded);
    storages.invalidateStats();
    job.size = job.loaded;
    job.file = storages.fileInfo(st, rel, job.loaded, new Date());
    job.status = 'done';
  } catch (err) {
    if (uploadId) await st.abortMultipart(rel, uploadId).catch(() => {});
    job.status = signal.aborted ? 'cancelled' : 'error';
    job.error = signal.aborted ? 'Отменено' : (err.message || 'Ошибка загрузки');
  } finally {
    setTimeout(() => jobs.delete(job.id), KEEP_FINISHED_MS).unref();
  }
}
