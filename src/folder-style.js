// Цвет и значок папки (общие для всех пользователей диска). Хранение — data/folder-style.json
// (0600): { "<путь/>": {color, icon} }. Следует за папкой при переносе (вызовы из labels.js).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const COLORS = ['green', 'blue', 'sky', 'violet', 'pink', 'red', 'orange', 'amber', 'slate'];
export const ICONS = ['folder', 'star', 'image', 'video', 'music', 'doc', 'archive', 'user', 'users', 'lock', 'home', 'calendar', 'chart', 'globe', 'server', 'clipboard', 'key', 'message'];
const MAX = 20_000;
const file = () => path.join(config.dataDir, 'folder-style.json');
let styles = new Map();

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (data && typeof data === 'object') styles = new Map(Object.entries(data));
} catch { /* ещё не настраивали */ }

let dirty = null;
function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(styles)), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
const persistSoon = () => { if (!dirty) dirty = setTimeout(() => { dirty = null; persist(); }, 1000).unref(); };
export function flush() { if (dirty) { clearTimeout(dirty); dirty = null; persist(); } }

export const get = (p) => styles.get(p) ?? null;

/** @returns {boolean} false — неверные значения или слишком много */
export function set(p, { color = null, icon = null } = {}) {
  if ((color && !COLORS.includes(color)) || (icon && !ICONS.includes(icon))) return false;
  if (!color && (!icon || icon === 'folder')) styles.delete(p);
  else {
    if (!styles.has(p) && styles.size >= MAX) return false;
    styles.set(p, { ...(color && { color }), ...(icon && icon !== 'folder' && { icon }) });
  }
  persistSoon();
  return true;
}

export function refolder(oldPath, newPath) {
  let changed = false;
  for (const [p, v] of [...styles]) {
    if (!p.startsWith(oldPath)) continue;
    styles.delete(p);
    styles.set(newPath + p.slice(oldPath.length), v);
    changed = true;
  }
  if (changed) persistSoon();
}

export function forgetFolder(prefix) {
  let changed = false;
  for (const p of [...styles.keys()]) if (p.startsWith(prefix)) { styles.delete(p); changed = true; }
  if (changed) persistSoon();
}
