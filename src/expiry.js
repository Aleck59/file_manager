// Срок хранения файла: «удалить через N дней» — по сроку файл сам уходит в корзину
// (если корзина выключена — удаляется). Хранение — data/expiry.json (0600):
// { "<хранилище>:<ключ>": "<ISO-дата>" }. Следует за файлом так же, как метки (вызовы из labels.js).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX = 50_000;
const file = () => path.join(config.dataDir, 'expiry.json');
let dates = new Map();

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (data && typeof data === 'object') dates = new Map(Object.entries(data).filter(([, v]) => !Number.isNaN(Date.parse(v))));
} catch { /* сроков ещё нет */ }

let dirty = null;
function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(dates)), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
const persistSoon = () => { if (!dirty) dirty = setTimeout(() => { dirty = null; persist(); }, 1000).unref(); };
export function flush() { if (dirty) { clearTimeout(dirty); dirty = null; persist(); } }

export const get = (key) => dates.get(key) ?? null;

/** @param {string|null} iso — null убирает срок. @returns {boolean} false — слишком много сроков */
export function set(key, iso) {
  if (iso === null) dates.delete(key);
  else {
    if (!dates.has(key) && dates.size >= MAX) return false;
    dates.set(key, iso);
  }
  persistSoon();
  return true;
}

/** Ключи, срок которых наступил. */
export function due(now = Date.now()) {
  return [...dates].filter(([, iso]) => Date.parse(iso) <= now).map(([key]) => key);
}

export function rekey(oldKey, newKey) {
  const d = dates.get(oldKey);
  if (!d) return;
  dates.delete(oldKey);
  dates.set(newKey, d);
  persistSoon();
}

export function forget(key) {
  if (dates.delete(key)) persistSoon();
}

export function refolder(oldPath, newPath) {
  let changed = false;
  for (const [key, d] of [...dates]) {
    const i = key.indexOf(':');
    const rel = key.slice(i + 1);
    if (!rel.startsWith(oldPath)) continue;
    dates.delete(key);
    dates.set(`${key.slice(0, i + 1)}${newPath}${rel.slice(oldPath.length)}`, d);
    changed = true;
  }
  if (changed) persistSoon();
}

export function forgetFolder(p) {
  let changed = false;
  for (const key of [...dates.keys()]) {
    if (key.slice(key.indexOf(':') + 1).startsWith(p)) { dates.delete(key); changed = true; }
  }
  if (changed) persistSoon();
}
