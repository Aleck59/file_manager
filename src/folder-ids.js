// Короткие ID папок для адресов страниц (#/disk/<ID>). ID — хеш пути; браузер вычисляет его
// сам (public/js/folder-id.js — тот же алгоритм), а сервер хранит обратную таблицу ID → путь.
// Таблица пополняется, когда папки попадают в списки, и при промахе — обходом бакетов.
// Хранение — data/folder-ids.json. После переименования папки у неё новый ID.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { isReservedFolder, isValidFolder } from './keys.js';
import * as storages from './storages.js';

export function folderId(p) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < p.length; i++) {
    const ch = p.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, '0');
}
export const ID_RE = /^[0-9a-z]{11}$/;

const file = () => path.join(config.dataDir, 'folder-ids.json');
let ids = new Map(); // ID → путь
try {
  ids = new Map(Object.entries(JSON.parse(fs.readFileSync(file(), 'utf8'))));
} catch { /* таблицы ещё нет */ }

let dirty = null;
function persistSoon() {
  if (dirty) return;
  dirty = setTimeout(() => {
    dirty = null;
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(ids)), { mode: 0o600 });
    fs.renameSync(tmp, file());
  }, 5000);
  dirty.unref();
}
export function flush() {
  if (!dirty) return;
  clearTimeout(dirty);
  dirty = null;
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify(Object.fromEntries(ids)), { mode: 0o600 });
}

/** Запомнить папку и всех её предков. */
export function remember(folder) {
  for (let f = folder; f; f = f.slice(0, f.slice(0, -1).lastIndexOf('/') + 1)) {
    const id = folderId(f);
    if (ids.get(id) === f) break; // предки уже известны
    if (!ids.has(id) && ids.size < 500_000) { ids.set(id, f); persistSoon(); }
  }
}

let lastScan = 0;
/** Путь по ID; при промахе — один обход бакетов (не чаще раза в 30 с). */
export async function resolve(id) {
  if (!ID_RE.test(id)) return null;
  if (ids.has(id)) return ids.get(id);
  if (Date.now() - lastScan < 30_000) return null;
  lastScan = Date.now();
  for (const st of storages.all()) {
    await st.forEachObject('', (o) => {
      const slash = o.rel.lastIndexOf('/');
      if (slash < 0) return;
      const folder = o.rel.slice(0, slash + 1);
      if (isValidFolder(folder) && !isReservedFolder(folder)) remember(folder);
    }, { max: 200_000 }).catch(() => {});
    if (ids.has(id)) break;
  }
  return ids.get(id) ?? null;
}
