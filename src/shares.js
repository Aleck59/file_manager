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

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Состояние ссылки: active | expired | exhausted | revoked | missing */
export function stateOf(s, now = Date.now()) {
  if (s.revoked) return 'revoked';
  if (s.missing) return 'missing';
  if (s.expiresAt && Date.parse(s.expiresAt) <= now) return 'expired';
  if (s.type !== 'upload' && s.maxDownloads && s.downloads >= s.maxDownloads) return 'exhausted';
  if (s.type === 'upload' && s.maxUploads && s.uploads >= s.maxUploads) return 'exhausted';
  return 'active';
}

/** Описание для владельца (без хеша пароля). */
export function ownerView(s) {
  const { passwordHash, ...rest } = s;
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
  const share = {
    id: newId(),
    type: input.type,
    key: input.type === 'file' ? input.key : undefined,
    folder: input.type !== 'file' ? input.folder : undefined,
    name: String(input.name ?? '').slice(0, 200),
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

export const get = (id) => (typeof id === 'string' && ID_RE.test(id) ? shares.find((s) => s.id === id) ?? null : null);
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

export function touch(s, field) {
  s.lastAccess = new Date().toISOString();
  if (field) s[field] = (s[field] ?? 0) + 1;
  if (field) persist(); else persistSoon();
}

// ---------- согласование с изменениями файлов и папок ----------
export function rekeyFile(oldKey, newKey) {
  let changed = false;
  for (const s of shares) if (s.type === 'file' && s.key === oldKey) { s.key = newKey; changed = true; }
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
export function refolder(oldPath, newPath) {
  let changed = false;
  for (const s of shares) {
    if (s.folder && s.folder.startsWith(oldPath)) { s.folder = newPath + s.folder.slice(oldPath.length); changed = true; }
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
