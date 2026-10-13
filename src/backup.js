// Резервное копирование одного хранилища в другое (другой бакет или другой провайдер).
//
// Копия лежит в служебной папке целевого хранилища: «.backup/<id исходного>/<ключ>» — в диске
// она не видна, в статистике показана отдельно. Копируются новые и изменённые файлы (по размеру
// и дате), неизменные пропускаются. По желанию удалённые в источнике удаляются и из копии.
// Корзина источника не копируется. Байты идут через сервер потоком (память — одна часть 5 МБ).
//
// «Восстановить» возвращает в источник файлы, которых там нет (например, после ошибочного
// удаления мимо корзины или потери бакета). Существующие файлы не перезаписываются.
//
// Настройки и итоги последних запусков — data/backup.json (0600). Расписание — ежедневно
// или еженедельно в заданный час (по времени сервера).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { BACKUP, isReservedFolder } from './keys.js';
import * as storages from './storages.js';
import { createJob, finishJob, streamInto } from './url-import.js';

const file = () => path.join(config.dataDir, 'backup.json');
const MAX_INDEX = 300_000; // объектов в одной копии — дальше индекс в памяти слишком велик
const fail = (status, message) => Object.assign(new Error(message), { status });
let state = { plans: [], runs: {} };

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (Array.isArray(data.plans)) state = { plans: data.plans, runs: data.runs ?? {} };
} catch { /* копий ещё нет */ }

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export const list = () => state.plans.map((p) => ({ ...p, last: state.runs[p.id] ?? null, running: running.has(p.id) }));

/**
 * @param {{source, target, schedule: 'off'|'daily'|'weekly', hour, mirror: boolean}} input
 */
export function save(input, id) {
  const source = storages.get(input.source);
  const target = storages.get(input.target);
  if (!source || !target) throw fail(400, 'Выберите оба хранилища');
  if (source.id === target.id) throw fail(400, 'Копия в то же хранилище не защитит от его потери — выберите другое');
  if (!['off', 'daily', 'weekly'].includes(input.schedule)) throw fail(400, 'Расписание: off, daily или weekly');
  const hour = Number(input.hour ?? 3);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw fail(400, 'Час — от 0 до 23');
  const plan = { id: id ?? crypto.randomBytes(6).toString('hex'), source: source.id, target: target.id, schedule: input.schedule, hour, mirror: Boolean(input.mirror) };
  const others = state.plans.filter((p) => p.id !== plan.id);
  if (others.some((p) => p.source === plan.source && p.target === plan.target)) throw fail(409, 'Такая копия уже настроена');
  state.plans = [...others, plan];
  persist();
  return plan;
}

export function remove(id) {
  const before = state.plans.length;
  state.plans = state.plans.filter((p) => p.id !== id);
  delete state.runs[id];
  if (state.plans.length !== before) persist();
  return state.plans.length !== before;
}

const running = new Map(); // id плана → задание

/** Запуск копирования (или восстановления) в фоне. @returns задание (статус — GET /api/jobs/:id) */
export function start(id, { user, restore = false } = {}) {
  const plan = state.plans.find((p) => p.id === id);
  if (!plan) throw fail(404, 'Резервная копия не найдена');
  if (running.has(id)) throw fail(409, 'Копирование уже идёт');
  const source = storages.get(plan.source);
  const target = storages.get(plan.target);
  if (!source || !target) throw fail(400, 'Одно из хранилищ отключено');
  const job = createJob({ type: restore ? 'restore' : 'backup', user, name: restore ? `${target.name} → ${source.name}` : `${source.name} → ${target.name}`, size: 0 });
  running.set(id, job);
  const work = restore ? doRestore(plan, source, target, job) : doBackup(plan, source, target, job);
  work.then((stats) => {
    job.status = 'done';
    job.result = stats;
    record(plan, job, stats, restore);
  }, (err) => {
    const cancelled = job.controller.signal.aborted;
    job.status = cancelled ? 'cancelled' : 'error';
    job.error = cancelled ? 'Отменено' : err.message;
    record(plan, job, { error: job.error }, restore);
    console.error(`[backup] ${job.name}: ${job.error}`);
  }).finally(() => {
    running.delete(id);
    finishJob(job);
    storages.invalidateStats();
  });
  return { id: job.id, type: job.type, name: job.name, status: job.status };
}

function record(plan, job, stats, restore) {
  state.runs[plan.id] = { at: new Date().toISOString(), kind: restore ? 'restore' : 'backup', status: job.status, ...stats };
  persist();
}

const backupRoot = (plan) => `${BACKUP}${plan.source}/`;

/** Индекс копии: относительный ключ → {size, lastModified}. */
async function indexOf(st, prefix, job) {
  const map = new Map();
  await st.forEachObject(prefix, (o) => {
    if (job.controller.signal.aborted) throw new Error('Отменено');
    if (map.size >= MAX_INDEX) throw new Error(`Больше ${MAX_INDEX} файлов — копирование такого объёма не поддерживается`);
    map.set(o.rel.slice(prefix.length), { size: o.size, lastModified: o.lastModified });
  });
  return map;
}

async function copyObject(from, fromRel, to, toRel, job) {
  const { body, contentType } = await from.getStream(fromRel);
  job.controller.signal.addEventListener('abort', () => body.destroy?.(), { once: true });
  let uploadId = null;
  const sub = { loaded: 0, controller: job.controller };
  try {
    await streamInto(to, toRel, contentType, body, sub, (n) => { uploadId = n; });
  } catch (err) {
    if (uploadId) await to.abortMultipart(toRel, uploadId).catch(() => {});
    throw err;
  } finally {
    job.loaded += sub.loaded;
  }
}

async function doBackup(plan, source, target, job) {
  const root = backupRoot(plan);
  const existing = await indexOf(target, root, job);
  const stats = { copied: 0, skipped: 0, deleted: 0, failed: 0, bytes: 0 };
  const seen = new Set();
  await source.forEachObject('', async (o) => {
    if (job.controller.signal.aborted) throw new Error('Отменено');
    if (isReservedFolder(o.rel)) return; // корзина и чужие копии
    seen.add(o.rel);
    const have = existing.get(o.rel);
    // Копия не старше оригинала и того же размера — без изменений.
    if (have && have.size === o.size && (have.lastModified ?? '') >= (o.lastModified ?? '')) { stats.skipped++; return; }
    job.size += o.size;
    try {
      await copyObject(source, o.rel, target, root + o.rel, job);
      stats.copied++;
      stats.bytes += o.size;
    } catch (err) {
      if (job.controller.signal.aborted) throw err;
      stats.failed++;
      console.error(`[backup] ${o.rel}: ${err.message}`);
    }
  });
  if (plan.mirror) {
    const gone = [...existing.keys()].filter((rel) => !seen.has(rel)).map((rel) => root + rel);
    if (gone.length) await target.deleteMany(gone);
    stats.deleted = gone.length;
  }
  return stats;
}

async function doRestore(plan, source, target, job) {
  const root = backupRoot(plan);
  const present = new Set();
  await source.forEachObject('', (o) => { present.add(o.rel); });
  const stats = { restored: 0, skipped: 0, failed: 0, bytes: 0 };
  await target.forEachObject(root, async (o) => {
    if (job.controller.signal.aborted) throw new Error('Отменено');
    const rel = o.rel.slice(root.length);
    if (present.has(rel)) { stats.skipped++; return; }
    job.size += o.size;
    try {
      await copyObject(target, o.rel, source, rel, job);
      stats.restored++;
      stats.bytes += o.size;
    } catch (err) {
      if (job.controller.signal.aborted) throw err;
      stats.failed++;
    }
  });
  return stats;
}

// ---------- расписание ----------
function due(plan, now) {
  if (plan.schedule === 'off' || now.getHours() !== plan.hour) return false;
  if (plan.schedule === 'weekly' && now.getDay() !== 0) return false; // по воскресеньям
  const last = state.runs[plan.id];
  return !last || now - new Date(last.at) > 20 * 3600_000;
}

export function startScheduler() {
  const tick = () => {
    const now = new Date();
    for (const plan of state.plans) {
      if (!due(plan, now) || running.has(plan.id)) continue;
      try {
        start(plan.id, { user: 'расписание' });
        console.log(`[backup] запуск по расписанию: ${plan.source} → ${plan.target}`);
      } catch (err) {
        console.error('[backup]', err.message);
      }
    }
  };
  setInterval(tick, 10 * 60_000).unref();
}
