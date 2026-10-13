// Реестр активных сессий: для списка «Где выполнен вход» и завершения отдельной сессии.
// Сам токен по-прежнему самодостаточен (HMAC), реестр — дополнительная проверка:
// завершённая сессия удаляется отсюда, а её подпись — в список отозванных (auth.js).
// Сессии, выданные до появления реестра, добавляются при первом обращении.
// lastSeen обновляется не чаще раза в минуту и пишется на диск не чаще раза в 30 с.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = () => path.join(config.dataDir, 'sessions.json');
const TOUCH_MS = 60_000;
const MAX_PER_USER = 50;
let sessions = new Map(); // nonce → { user, sig, exp, created, lastSeen, ip, ua, fp }
let dirtyTimer = null;

try {
  sessions = new Map(Object.entries(JSON.parse(fs.readFileSync(file(), 'utf8'))));
} catch { /* реестра ещё нет */ }

function persist() {
  clearTimeout(dirtyTimer);
  dirtyTimer = null;
  const now = Date.now() / 1000;
  for (const [nonce, s] of sessions) if (s.exp < now) sessions.delete(nonce);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch (err) {
    console.error('[sessions] не удалось сохранить:', err.message);
  }
}
const persistSoon = () => { if (!dirtyTimer) dirtyTimer = setTimeout(persist, 30_000).unref(); };

// Отпечаток пароля пользователя и секрета сессий: смена любого делает сессию мёртвой,
// и в списке её показывать не нужно.
export const fingerprint = (user) => crypto.createHash('sha256')
  .update(`${user.passwordHash}|${config.auth.sessionSecret}`).digest('base64url').slice(0, 12);

const meta = (req) => ({
  ip: req?.ip ?? null,
  ua: String(req?.headers?.['user-agent'] ?? '').slice(0, 200),
});

/** Новая сессия (при входе). */
export function register({ nonce, sig, exp, user, req }) {
  const now = new Date().toISOString();
  sessions.set(nonce, { user: user.username, sig, exp, created: now, lastSeen: now, fp: fingerprint(user), ...meta(req) });
  // Не даём реестру расти бесконечно: у пользователя — не больше MAX_PER_USER, старые уходят.
  const mine = [...sessions].filter(([, s]) => s.user === user.username).sort((a, b) => (a[1].lastSeen < b[1].lastSeen ? -1 : 1));
  for (const [n] of mine.slice(0, Math.max(0, mine.length - MAX_PER_USER))) sessions.delete(n);
  persist();
}

/** Действующий токен: отмечаем активность; сессия до реестра — добавляем. */
export function touch({ nonce, sig, exp, user, req }) {
  const s = sessions.get(nonce);
  if (!s) return register({ nonce, sig, exp, user, req });
  const now = Date.now();
  if (now - Date.parse(s.lastSeen) < TOUCH_MS) return;
  Object.assign(s, { lastSeen: new Date(now).toISOString(), ...meta(req) });
  persistSoon();
}

export function forget(nonce) {
  if (sessions.delete(nonce)) persist();
}

/** Сессии пользователя (живые), новые сверху. */
export function listFor(user) {
  const now = Date.now() / 1000;
  const fp = fingerprint(user);
  return [...sessions]
    .filter(([, s]) => s.user === user.username && s.exp > now && s.fp === fp)
    .map(([id, s]) => ({ id, created: s.created, lastSeen: s.lastSeen, ip: s.ip, ua: s.ua, exp: s.exp }))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

export const get = (nonce) => sessions.get(nonce) ?? null;

export function flush() {
  if (dirtyTimer) persist();
}
