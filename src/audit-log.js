// Журнал действий для раздела «Журнал» (только администратор).
// Пишется в data/audit.log (JSON Lines, права 0600), при 2 МБ файл переименовывается в
// audit.log.1 (хранится одна прошлая часть). В памяти — последние MAX_MEMORY записей,
// при старте подгружаются из файла. В stdout по-прежнему идут строки [audit]/[auth]
// (для journalctl и fail2ban) — этот журнал их не заменяет, а дополняет.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_MEMORY = 2000;
const MAX_FILE = 2 * 1024 * 1024;
const file = () => path.join(config.dataDir, 'audit.log');
let entries = [];

function load() {
  try {
    const fd = fs.openSync(file(), 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const len = Math.min(size, 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (len < size) lines.shift(); // первая строка могла быть обрезана
      for (const line of lines) {
        if (!line) continue;
        try { entries.push(JSON.parse(line)); } catch { /* повреждённая строка */ }
      }
      entries = entries.slice(-MAX_MEMORY);
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* журнала ещё нет */ }
}
load();

/** @param {{user: string, action: string, details?: object, ip?: string}} e */
export function record({ user, action, details = {}, ip }) {
  const entry = { at: new Date().toISOString(), user: user ?? '-', action, details, ip: ip ?? null };
  entries.push(entry);
  if (entries.length > MAX_MEMORY) entries.splice(0, entries.length - MAX_MEMORY);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file()).size > MAX_FILE) fs.renameSync(file(), `${file()}.1`);
    } catch { /* файла ещё нет */ }
    fs.appendFileSync(file(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error('[audit] не удалось записать журнал:', err.message);
  }
}

/**
 * Последние записи, новые сверху.
 * @param {{ limit?: number, before?: string, user?: string, action?: string, q?: string }} filter
 */
export function list({ limit = 100, before, user, action, q } = {}) {
  const needle = q?.toLowerCase();
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (before && e.at >= before) continue;
    if (user && e.user !== user) continue;
    if (action && !e.action.startsWith(action)) continue;
    if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return { entries: out, users: [...new Set(entries.map((e) => e.user))].sort() };
}
