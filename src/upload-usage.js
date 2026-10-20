// Лимит загрузки в день: сколько байт пользователь загрузил сегодня (сайт, по ссылке, WebDAV).
// Лимит — из профиля пользователя (dailyUploadMb: 0 — без лимита) или из настройки
// DAILY_UPLOAD_MB для роли «Редактор». Администраторов не ограничивает.
// Хранение — data/upload-usage.json (0600), только текущие сутки (по часам сервера).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MB = 1024 * 1024;
const file = () => path.join(config.dataDir, 'upload-usage.json');
let state = { day: '', users: {} };

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (data && typeof data.day === 'string' && typeof data.users === 'object') state = data;
} catch { /* ещё ничего не загружали */ }

const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function current() {
  const day = today();
  if (state.day !== day) state = { day, users: {} };
  return state.users;
}

let dirty = null;
function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
const persistSoon = () => { if (!dirty) dirty = setTimeout(() => { dirty = null; persist(); }, 2000).unref(); };
export function flush() { if (dirty) { clearTimeout(dirty); dirty = null; persist(); } }

/** Лимит в байтах на сегодня или null (без лимита). */
export function limitFor(user) {
  if (!user || user.role === 'admin') return null;
  const mb = user.dailyUploadMb ?? (user.role === 'editor' ? config.limits.dailyUploadMb : 0);
  return mb > 0 ? mb * MB : null;
}

export const usedToday = (user) => current()[user.username] ?? 0;

/** Сколько ещё можно загрузить сегодня (null — без лимита). Бросает 429, если лимит исчерпан или файл не влезает. */
export function check(user, size = 0) {
  const limit = limitFor(user);
  if (limit === null) return null;
  const left = limit - usedToday(user);
  if (left <= 0 || (Number.isSafeInteger(size) && size > left)) {
    const mb = (n) => Math.max(0, Math.floor(n / MB));
    throw Object.assign(new Error(`Дневной лимит загрузки: осталось ${mb(left)} МБ из ${mb(limit)} МБ. Лимит обновится завтра`), { status: 429 });
  }
  return left;
}

export function note(user, size) {
  if (!user || !(size > 0) || limitFor(user) === null) return;
  const users = current();
  users[user.username] = (users[user.username] ?? 0) + size;
  persistSoon();
}
