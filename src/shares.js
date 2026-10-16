// Публичные ссылки через сайт: /s/<id>.
// Виды: file — скачать файл; folder — просмотр и скачивание файлов папки (с подпапками);
// upload — «загрузить мне»: гость может только загружать файлы в папку, ничего не видя.
// Параметры: срок, пароль (scrypt), лимит скачиваний/загрузок, отзыв. Статистика: число
// скачиваний и загрузок, последнее обращение. Хранение — data/shares.json (0600).
//
// Ссылка следует за файлом: при переименовании/перемещении/переносе ключ обновляется
// (rekeyFile), при удалении файла ссылка помечается «файл удалён». Папки — по префиксу.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword, verifyPassword } from './password.js';

const file = () => path.join(config.dataDir, 'shares.json');
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const UNLOCK_TTL = 12 * 3600;
let shares = [];

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (Array.isArray(data)) shares = data;
} catch { /* ссылок ещё нет */ }

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shares, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
let dirty = null;
const persistSoon = () => { if (!dirty) dirty = setTimeout(() => { dirty = null; persist(); }, 10_000).unref(); };
export function flush() { if (dirty) { clearTimeout(dirty); dirty = null; persist(); } }

// 12 символов из 57 — ~70 бит: перебором не найти.
function newId() {
  const bytes = crypto.randomBytes(12);
  let id = '';
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return shares.some((s) => s.id === id) ? newId() : id;
}
const ID_RE = /^[a-zA-Z0-9]{12}$/;

// Короткий адрес портала: files.example.com/<адрес> (латиница, цифры, дефис). Адреса страниц
// и служебных файлов сайта заняты.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['api', 's', 'login', 'logout', 'dav', 'css', 'js', 'icons', 'index', 'index.html', 'login.html', 'share.html',
  'offline.html', 'sw.js', 'favicon.svg', 'manifest.webmanifest', 'share-target', 'branding', 'admin', 'settings', 'healthz', 'robots.txt']);

function checkSlug(slug, selfId) {
  if (slug === null || slug === undefined || slug === '') return null;
  const v = String(slug).trim().toLowerCase();
  if (!SLUG_RE.test(v) || RESERVED.has(v)) throw fail(400, 'Адрес: латиница, цифры и дефис, до 40 символов (служебные слова заняты)');
  if (shares.some((x) => x.slug === v && x.id !== selfId && !x.revoked)) throw fail(409, `Адрес «${v}» уже занят другой ссылкой`);
  return v;
}
const checkCaption = (c) => (c === null || c === undefined ? null : String(c).trim().slice(0, 200) || null);

const fail = (status, message) => Object.assign(new Error(message), { status });

// «Запросить файл»: одноразовый портал. Закрывается, когда гость нажал «Готово»,
// или через час после последнего загруженного файла (если просто закрыл страницу).
const REQUEST_GRACE = 60 * 60_000;
const LOG_MAX = 1000;

/** Состояние ссылки: active | expired | exhausted | revoked | missing | fulfilled */
export function stateOf(s, now = Date.now()) {
  if (s.revoked) return 'revoked';
  if (s.missing) return 'missing';
  if (s.request && (s.fulfilledAt || (s.lastUploadAt && now - Date.parse(s.lastUploadAt) > REQUEST_GRACE))) return 'fulfilled';
  if (s.expiresAt && Date.parse(s.expiresAt) <= now) return 'expired';
  if (s.type !== 'upload' && s.maxDownloads && s.downloads >= s.maxDownloads) return 'exhausted';
  if (s.type === 'upload' && s.maxUploads && s.uploads >= s.maxUploads) return 'exhausted';
  return 'active';
}

/** Описание для владельца (без хеша пароля). */
export function ownerView(s) {
  const { passwordHash, uploadLog, fileDownloads, ...rest } = s; // журнал загрузок — отдельно (statsOf)
  return { ...rest, hasPassword: Boolean(passwordHash), state: stateOf(s) };
}

/**
 * @param {{ type: 'file'|'folder'|'upload', key?: string, folder?: string, name: string, user: string,
 *   expiresInDays?: number|null, password?: string, maxDownloads?: number|null, maxUploads?: number|null,
 *   maxFileSizeMb?: number|null }} input
 */
export async function create(input) {
  if (!['file', 'folder', 'upload'].includes(input.type)) throw fail(400, 'Неизвестный вид ссылки');
  const days = input.expiresInDays == null || input.expiresInDays === '' ? null : Number(input.expiresInDays);
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 365)) throw fail(400, 'Срок — от 1 до 365 дней или «бессрочно»');
  const limit = (v, max) => {
    if (v == null || v === '' || v === 0) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw fail(400, `Лимит — целое число от 1 до ${max}`);
    return n;
  };
  const password = typeof input.password === 'string' ? input.password : '';
  if (password && (password.length < 4 || password.length > 128)) throw fail(400, 'Пароль ссылки — от 4 до 128 символов');
  const request = input.type === 'upload' && input.request === true;
  if (request && !days) throw fail(400, 'У запроса файла нужен срок');
  const share = {
    id: newId(),
    type: input.type,
    key: input.type === 'file' ? input.key : undefined,
    folder: input.type !== 'file' ? input.folder : undefined,
    name: String(input.name ?? '').slice(0, 200),
    slug: checkSlug(input.slug),
    caption: checkCaption(input.caption),
    request: request || undefined,
    createdBy: input.user,
    createdAt: new Date().toISOString(),
    expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    passwordHash: password ? await hashPassword(password) : null,
    maxDownloads: input.type === 'upload' ? null : limit(input.maxDownloads, 100_000),
    maxUploads: input.type === 'upload' ? limit(input.maxUploads, 10_000) : null,
    maxFileSizeMb: input.type === 'upload' ? limit(input.maxFileSizeMb, 5 * 1024 * 1024) : null,
    downloads: 0,
    uploads: 0,
    lastAccess: null,
    revoked: false,
  };
  shares.push(share);
  persist();
  return share;
}

export function get(id) {
  if (typeof id !== 'string') return null;
  if (ID_RE.test(id)) {
    const byId = shares.find((s) => s.id === id);
    if (byId) return byId;
  }
  // Короткий адрес: действующая ссылка важнее отозванной с тем же адресом.
  const slug = id.toLowerCase();
  return shares.find((s) => s.slug === slug && !s.revoked) ?? shares.find((s) => s.slug === slug) ?? null;
}

/** Изменить короткий адрес и подпись. */
export function update(id, user, isAdmin, { slug, caption }) {
  const s = get(id);
  if (!s || s.id !== id || (!isAdmin && s.createdBy !== user)) return null;
  if (slug !== undefined) s.slug = checkSlug(slug, s.id);
  if (caption !== undefined) s.caption = checkCaption(caption);
  persist();
  return s;
}
export const listFor = (user, all = false) => shares.filter((s) => all || s.createdBy === user).map(ownerView)
  .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

export function revoke(id, user, isAdmin) {
  const s = get(id);
  if (!s || (!isAdmin && s.createdBy !== user)) return false;
  s.revoked = true;
  persist();
  return true;
}

/** Удалить запись совсем (из списка). */
export function remove(id, user, isAdmin) {
  const s = get(id);
  if (!s || (!isAdmin && s.createdBy !== user)) return false;
  shares = shares.filter((x) => x.id !== id);
  persist();
  return true;
}

/** Гость загрузил файл через портал: журнал (когда, кто, откуда, что) и итоги. */
export function noteUpload(s, { name, size, ip, from }) {
  s.uploadLog ??= [];
  s.uploadLog.push({ at: new Date().toISOString(), name, size, ip: ip ?? null, from: from || null });
  if (s.uploadLog.length > LOG_MAX) s.uploadLog.splice(0, s.uploadLog.length - LOG_MAX);
  s.uploadedBytes = (s.uploadedBytes ?? 0) + (size ?? 0);
  s.lastUploadAt = new Date().toISOString();
  touch(s, 'uploads');
}

/** Гость нажал «Готово» на запросе файла — ссылка закрывается. */
export function fulfil(s) {
  s.fulfilledAt = new Date().toISOString();
  persist();
}

/** Статистика портала для владельца. */
export function statsOf(s) {
  const log = s.uploadLog ?? [];
  return {
    uploads: s.uploads ?? 0,
    bytes: s.uploadedBytes ?? 0,
    senders: new Set(log.map((e) => e.from || e.ip).filter(Boolean)).size,
    lastUploadAt: s.lastUploadAt ?? null,
    log: [...log].reverse(),
  };
}

export function touch(s, field) {
  s.lastAccess = new Date().toISOString();
  if (field) s[field] = (s[field] ?? 0) + 1;
  if (field) persist(); else persistSoon();
}

/** Скачивание одного файла по ссылке на папку: счётчик по файлу (и общий счётчик ссылки). */
export function touchFile(s, key) {
  s.fileDownloads ??= {};
  s.fileDownloads[key] = (s.fileDownloads[key] ?? 0) + 1;
  touch(s, 'downloads');
}

/**
 * Публичность файлов для списка папки: сколько раз файл скачали по ссылкам
 * и есть ли у него сейчас действующая ссылка (своя или на папку, где он лежит).
 * @returns {(key: string, folder: string) => {downloads: number, active: boolean} | null}
 */
export function publicIndex() {
  const downloads = new Map();
  const activeKeys = new Set();
  const activeFolders = [];
  for (const s of shares) {
    const active = stateOf(s) === 'active';
    if (s.type === 'file') {
      downloads.set(s.key, (downloads.get(s.key) ?? 0) + (s.downloads ?? 0));
      if (active) activeKeys.add(s.key);
    } else if (s.type === 'folder') {
      for (const [k, n] of Object.entries(s.fileDownloads ?? {})) downloads.set(k, (downloads.get(k) ?? 0) + n);
      if (active) activeFolders.push(s.folder);
    }
  }
  return (key, folder) => {
    const active = activeKeys.has(key) || activeFolders.some((p) => folder.startsWith(p));
    const n = downloads.get(key) ?? 0;
    return active || n ? { downloads: n, active } : null;
  };
}

// ---------- согласование с изменениями файлов и папок ----------
export function rekeyFile(oldKey, newKey) {
  let changed = false;
  for (const s of shares) {
    if (s.type === 'file' && s.key === oldKey) { s.key = newKey; changed = true; }
    if (s.fileDownloads?.[oldKey] !== undefined) {
      s.fileDownloads[newKey] = (s.fileDownloads[newKey] ?? 0) + s.fileDownloads[oldKey];
      delete s.fileDownloads[oldKey];
      changed = true;
    }
  }
  if (changed) persist();
}
export function fileGone(key) {
  let changed = false;
  for (const s of shares) if (s.type === 'file' && s.key === key && !s.missing) { s.missing = true; changed = true; }
  if (changed) persist();
}
// Файл или папку вернули из корзины — ссылки снова работают.
export function fileBack(key) {
  let changed = false;
  for (const s of shares) if (s.type === 'file' && s.key === key && s.missing) { s.missing = false; changed = true; }
  if (changed) persist();
}
export function folderBack(pathPrefix) {
  let changed = false;
  for (const s of shares) if (s.folder?.startsWith(pathPrefix) && s.missing) { s.missing = false; changed = true; }
  if (changed) persist();
}
// Папку переименовали/переместили: ссылки на неё, её подпапки и файлы внутри следуют за ней.
export function refolder(oldPath, newPath) {
  let changed = false;
  for (const s of shares) {
    if (s.folder && s.folder.startsWith(oldPath)) { s.folder = newPath + s.folder.slice(oldPath.length); changed = true; }
    if (s.type === 'file') {
      const i = s.key.indexOf(':');
      const rel = s.key.slice(i + 1);
      if (rel.startsWith(oldPath)) { s.key = `${s.key.slice(0, i + 1)}${newPath}${rel.slice(oldPath.length)}`; changed = true; }
    }
  }
  if (changed) persist();
}
export function folderGone(pathPrefix) {
  let changed = false;
  for (const s of shares) if (s.folder?.startsWith(pathPrefix) && !s.missing) { s.missing = true; changed = true; }
  if (changed) persist();
}

// ---------- пароль: «разблокировка» — подписанная cookie на 12 часов ----------
const unlockSig = (id, exp) => crypto.createHmac('sha256', config.auth.sessionSecret).update(`share|${id}|${exp}`).digest('base64url');
export const unlockCookieName = (id) => `fm_share_${id}`;

export async function unlock(s, password) {
  if (!s.passwordHash) return null;
  if (typeof password !== 'string' || !(await verifyPassword(password, s.passwordHash))) return null;
  const exp = Math.floor(Date.now() / 1000) + UNLOCK_TTL;
  return { value: `${exp}.${unlockSig(s.id, exp)}`, maxAge: UNLOCK_TTL * 1000 };
}

export function isUnlocked(s, cookieValue) {
  if (!s.passwordHash) return true;
  const [exp, sig] = String(cookieValue ?? '').split('.');
  if (!(Number(exp) > Date.now() / 1000) || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(unlockSig(s.id, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
