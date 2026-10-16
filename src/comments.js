// Комментарии к файлам: заметки, видные всем, кто может читать файл.
// Хранение — data/comments.json (0600): { "<хранилище>:<ключ>": [{id, user, text, at}] }.
// Следуют за файлом так же, как метки (вызовы из labels.js): переименование, перемещение,
// перенос папки; удаляются вместе с файлом навсегда.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_FILES = 20_000;
const MAX_PER_FILE = 200;
export const MAX_TEXT = 2000;
const file = () => path.join(config.dataDir, 'comments.json');
let comments = new Map();

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (data && typeof data === 'object') comments = new Map(Object.entries(data).filter(([, v]) => Array.isArray(v)));
} catch { /* комментариев ещё нет */ }

let dirty = null;
function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(comments)), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
const persistSoon = () => { if (!dirty) dirty = setTimeout(() => { dirty = null; persist(); }, 1000).unref(); };
export function flush() { if (dirty) { clearTimeout(dirty); dirty = null; persist(); } }

export const list = (key) => comments.get(key) ?? [];
export const count = (key) => comments.get(key)?.length ?? 0;

/** @returns {{id, user, text, at}} */
export function add(key, user, text) {
  const body = String(text ?? '').trim();
  if (!body) throw Object.assign(new Error('Напишите комментарий'), { status: 400 });
  if (body.length > MAX_TEXT) throw Object.assign(new Error(`Комментарий длиннее ${MAX_TEXT} символов`), { status: 400 });
  const items = comments.get(key) ?? [];
  if (!items.length && comments.size >= MAX_FILES) throw Object.assign(new Error('Слишком много комментариев на диске'), { status: 507 });
  if (items.length >= MAX_PER_FILE) throw Object.assign(new Error('У файла слишком много комментариев'), { status: 400 });
  const c = { id: crypto.randomBytes(6).toString('base64url'), user, text: body, at: new Date().toISOString() };
  comments.set(key, [...items, c]);
  persistSoon();
  return c;
}

/** Удалить может автор или администратор. @returns {boolean|null} null — нет такого */
export function remove(key, id, user, isAdmin) {
  const items = comments.get(key) ?? [];
  const c = items.find((x) => x.id === id);
  if (!c) return null;
  if (c.user !== user && !isAdmin) return false;
  const rest = items.filter((x) => x.id !== id);
  if (rest.length) comments.set(key, rest); else comments.delete(key);
  persistSoon();
  return true;
}

export function rekey(oldKey, newKey) {
  const items = comments.get(oldKey);
  if (!items) return;
  comments.delete(oldKey);
  comments.set(newKey, [...(comments.get(newKey) ?? []), ...items]);
  persistSoon();
}

export function forget(key) {
  if (comments.delete(key)) persistSoon();
}

export function refolder(oldPath, newPath) {
  let changed = false;
  for (const [key, items] of [...comments]) {
    const i = key.indexOf(':');
    const rel = key.slice(i + 1);
    if (!rel.startsWith(oldPath)) continue;
    comments.delete(key);
    comments.set(`${key.slice(0, i + 1)}${newPath}${rel.slice(oldPath.length)}`, items);
    changed = true;
  }
  if (changed) persistSoon();
}

export function forgetFolder(p) {
  let changed = false;
  for (const key of [...comments.keys()]) {
    if (key.slice(key.indexOf(':') + 1).startsWith(p)) { comments.delete(key); changed = true; }
  }
  if (changed) persistSoon();
}
