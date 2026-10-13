// История занятого места для графика на главной: одна точка в день (последний подсчёт
// за день), до 400 дней, в data/usage-history.json. Пишется только при изменении.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_POINTS = 400;
const file = () => path.join(config.dataDir, 'usage-history.json');
let points = null;

function read() {
  if (points) return points;
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    points = Array.isArray(data) ? data.filter((p) => typeof p?.d === 'string' && Number.isFinite(p.size)) : [];
  } catch {
    points = [];
  }
  return points;
}

// Дата по местному времени сервера: «2026-10-13».
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Учитывает свежий подсчёт (только полный — частичный исказил бы график). */
export function recordUsage(stats) {
  if (!stats?.complete) return;
  const list = read();
  const point = { d: today(), size: stats.size, files: stats.files };
  const last = list.at(-1);
  if (last?.d === point.d) {
    if (last.size === point.size && last.files === point.files) return;
    list[list.length - 1] = point;
  } else {
    list.push(point);
  }
  if (list.length > MAX_POINTS) list.splice(0, list.length - MAX_POINTS);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch (err) {
    console.error('[stats] не удалось сохранить историю:', err.message);
  }
}

export const usageHistory = () => read().slice();
