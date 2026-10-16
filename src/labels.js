// Цветные метки файлов и папок (общие для всех пользователей диска).
// Хранение — data/labels.json (0600): { "<хранилище>:<ключ>": "red", "dir:<путь/>": "blue" }.
// Метка следует за файлом при переименовании/перемещении/переносе и за папкой при её
// перемещении. В корзине метка сохраняется (восстановленный файл — с ней же).
import fs from 'node:fs';
import path from 'node:path';
import * as comments from './comments.js';
import { config } from './config.js';

export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const MAX = 50_000;
const file = () => path.join(config.dataDir, 'labels.json');
let labels = new Map();

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (data && typeof data === 'object') labels = new Map(Object.entries(data).filter(([, c]) => COLORS.includes(c)));
} catch { /* меток ещё нет */ }

let dirty = null;
function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(labels)), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
const persistSoon = () => { if (!dirty) dirty = setTimeout(() => { dirty = null; persist(); }, 2000).unref(); };
export function flush() { if (dirty) { clearTimeout(dirty); dirty = null; persist(); } }

export const folderId = (p) => `dir:${p}`;
export const get = (id) => labels.get(id) ?? null;

/** @returns {boolean} false — слишком много меток */
export function set(id, color) {
  if (color === null) labels.delete(id);
  else {
    if (!labels.has(id) && labels.size >= MAX) return false;
    labels.set(id, color);
  }
  persistSoon();
  return true;
}

/** Все помеченные (для фильтра по всему диску). */
export function list(color) {
  const out = [];
  for (const [id, c] of labels) if (!color || c === color) out.push({ id, color: c });
  return out;
}

export function rekey(oldId, newId) {
  comments.rekey(oldId, newId); // комментарии следуют за файлом так же, как метки
  const c = labels.get(oldId);
  if (!c) return;
  labels.delete(oldId);
  labels.set(newId, c);
  persistSoon();
}

export function forget(id) {
  comments.forget(id);
  if (labels.delete(id)) persistSoon();
}

/** Папку перенесли: метки её самой, подпапок и файлов внутри — на новое место. */
export function refolder(oldPath, newPath) {
  comments.refolder(oldPath, newPath);
  let changed = false;
  for (const [id, c] of [...labels]) {
    const i = id.indexOf(':');
    const rel = id.slice(i + 1);
    if (!rel.startsWith(oldPath)) continue;
    labels.delete(id);
    labels.set(`${id.slice(0, i + 1)}${newPath}${rel.slice(oldPath.length)}`, c);
    changed = true;
  }
  if (changed) persistSoon();
}

/** Папку удалили навсегда — её метки больше не нужны. */
export function forgetFolder(p) {
  comments.forgetFolder(p);
  let changed = false;
  for (const id of [...labels.keys()]) {
    if (id.slice(id.indexOf(':') + 1).startsWith(p)) { labels.delete(id); changed = true; }
  }
  if (changed) persistSoon();
}
