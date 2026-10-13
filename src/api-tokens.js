// API-токены для скриптов и программ: заголовок «Authorization: Bearer fmt_<id>_<секрет>».
// Хранится только SHA-256 секрета (data/api-tokens.json, 0600) — сам токен показывается
// один раз при создании. Токен действует с правами владельца или только на чтение.
// Создавать и отзывать токены можно только из обычного входа (не токеном).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = () => path.join(config.dataDir, 'api-tokens.json');
const MAX_PER_USER = 10;
const TOKEN_RE = /^fmt_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
let tokens = [];
let dirtyTimer = null;

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (Array.isArray(data)) tokens = data;
} catch { /* токенов ещё нет */ }

function persist() {
  clearTimeout(dirtyTimer);
  dirtyTimer = null;
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

const hash = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
const publicToken = ({ hash: _h, ...rest }) => rest;

export const listFor = (username) => tokens.filter((t) => t.user === username).map(publicToken);

/** Создаёт токен; возвращает { token (показать один раз), info }. */
export function create(username, { name, readOnly }) {
  const label = String(name ?? '').trim().slice(0, 60);
  if (!label) throw Object.assign(new Error('Укажите название токена — например, «Бэкап с сервера»'), { status: 400 });
  if (tokens.filter((t) => t.user === username).length >= MAX_PER_USER) {
    throw Object.assign(new Error(`Не больше ${MAX_PER_USER} токенов — отзовите ненужные`), { status: 400 });
  }
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const info = { id, user: username, name: label, readOnly: Boolean(readOnly), created: new Date().toISOString(), lastUsed: null, lastIp: null };
  tokens.push({ ...info, hash: hash(secret) });
  persist();
  return { token: `fmt_${id}_${secret}`, info };
}

export function revoke(username, id) {
  const before = tokens.length;
  tokens = tokens.filter((t) => !(t.id === id && t.user === username));
  if (tokens.length === before) return false;
  persist();
  return true;
}

/** Проверяет заголовок Authorization. Возвращает запись токена или null. */
export function verify(header, ip) {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  const parts = m && TOKEN_RE.exec(m[1]);
  if (!parts) return null;
  const t = tokens.find((x) => x.id === parts[1]);
  if (!t) return null;
  const a = Buffer.from(hash(parts[2]), 'hex');
  const b = Buffer.from(t.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const now = Date.now();
  if (!t.lastUsed || now - Date.parse(t.lastUsed) > 60_000 || t.lastIp !== ip) {
    t.lastUsed = new Date(now).toISOString();
    t.lastIp = ip ?? null;
    if (!dirtyTimer) dirtyTimer = setTimeout(persist, 30_000).unref();
  }
  return publicToken(t);
}

export function flush() {
  if (dirtyTimer) persist();
}
