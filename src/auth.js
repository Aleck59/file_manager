// Аутентификация и авторизация.
// - Пароли хранятся только как scrypt-хеши.
// - Сессия — stateless-токен с HMAC-SHA256 в HttpOnly-cookie: в памяти ничего не хранится.
//   В подпись входит хеш пароля пользователя, поэтому смена пароля или удаление
//   пользователя сразу инвалидирует его сессии; смена SESSION_SECRET — все сессии.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as apiTokens from './api-tokens.js';
import { config } from './config.js';
import * as sessions from './sessions.js';
import { verifyPassword } from './password.js';
import { getUser, ROLES } from './users.js';

// Секрет и срок сессии можно менять в настройках — читаем их при каждом обращении.
// Имя cookie зависит от схемы APP_ORIGIN: префикс __Host- допустим только по HTTPS.
export const cookieName = () => (config.secureCookies ? '__Host-fm_session' : 'fm_session');

// Хеш-пустышка: при несуществующем логине всё равно считаем scrypt,
// чтобы по времени ответа нельзя было понять, есть ли такой пользователь.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export async function authenticate(username, password) {
  const user = getUser(username);
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  return ok && user ? user : null;
}

function sign(payload, user) {
  return crypto.createHmac('sha256', config.auth.sessionSecret).update(`${payload}|${user.passwordHash}`).digest('base64url');
}

// Формат: v3.<логин base64url>.<exp>.<случайная часть>.<подпись>. Случайная часть делает
// каждый токен уникальным: иначе выход и повторный вход в ту же секунду дали бы тот же
// (уже отозванный) токен.
export function issueToken(user) {
  const nonce = crypto.randomBytes(9).toString('base64url');
  const payload = `v3.${Buffer.from(user.username).toString('base64url')}.${Math.floor(Date.now() / 1000) + config.auth.sessionTtlSec}.${nonce}`;
  return `${payload}.${sign(payload, user)}`;
}

// ---------- отзыв сессий при выходе ----------
// Токен самодостаточен, поэтому «Выйти» должно явно его отозвать — иначе украденная cookie
// работала бы до истечения срока. Храним подписи отозванных токенов до их истечения
// (обычно единицы записей) в памяти и в data/revoked.json, чтобы пережить перезапуск.
const revokedFile = path.join(config.dataDir, 'revoked.json');
let revoked = new Map(); // подпись → exp (сек)
try {
  revoked = new Map(Object.entries(JSON.parse(fs.readFileSync(revokedFile, 'utf8'))));
} catch { /* файла ещё нет */ }

function persistRevoked() {
  const now = Date.now() / 1000;
  for (const [sig, exp] of revoked) if (exp < now) revoked.delete(sig);
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${revokedFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(revoked)), { mode: 0o600 });
  fs.renameSync(tmp, revokedFile);
}

/** Отзывает токен (если он действителен). */
export function revokeToken(token) {
  if (!userFromToken(token)) return;
  const parts = token.split('.');
  revoked.set(parts[4], Number(parts[2]));
  persistRevoked();
  sessions.forget(parts[3]);
}

/** Завершает одну из сессий пользователя (по id из списка). */
export function revokeSession(user, id) {
  const s = sessions.get(id);
  if (!s || s.user !== user.username) return false;
  revoked.set(s.sig, s.exp);
  persistRevoked();
  sessions.forget(id);
  return true;
}

// Части токена: [v3, логин, exp, nonce, подпись]
const tokenParts = (token) => {
  const p = token.split('.');
  return { nonce: p[3], sig: p[4], exp: Number(p[2]) };
};
export const sessionIdOf = (token) => (typeof token === 'string' ? token.split('.')[3] : null);

// Возвращает пользователя по токену или null.
export function userFromToken(token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v3') return null;
  const [, nameB64, exp, , sigB64] = parts;
  if (!(Number(exp) > Date.now() / 1000)) return null;
  if (revoked.has(sigB64)) return null;
  const user = getUser(Buffer.from(nameB64, 'base64url').toString());
  if (!user) return null;
  const sig = Buffer.from(sigB64);
  const expected = Buffer.from(sign(parts.slice(0, 4).join('.'), user));
  return sig.length === expected.length && crypto.timingSafeEqual(sig, expected) ? user : null;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function currentUser(req) {
  const token = readCookie(req, cookieName());
  const user = userFromToken(token);
  if (user) sessions.touch({ ...tokenParts(token), user, req });
  return user;
}

export function currentToken(req) {
  return readCookie(req, cookieName());
}

export function setSessionCookie(res, user) {
  const token = issueToken(user);
  sessions.register({ ...tokenParts(token), user, req: res.req });
  res.cookie(cookieName(), token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: config.auth.sessionTtlSec * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(cookieName(), { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/' });
}

export function requireAuth(req, res, next) {
  let user = currentUser(req);
  // API-токен (скрипты): только если нет cookie-сессии.
  if (!user && req.headers.authorization) {
    const token = apiTokens.verify(req.headers.authorization, req.ip);
    user = token && getUser(token.user);
    if (user) {
      req.apiToken = token;
      if (token.readOnly && !['GET', 'HEAD'].includes(req.method)) {
        return res.status(403).json({ error: 'Токен только для чтения' });
      }
    }
  }
  if (!user) return res.status(401).json({ error: 'Требуется вход в систему' });
  req.user = user;
  next();
}

/** Только обычный вход (не API-токен) — для управления токенами и сессиями. */
export function requireSession(req, res, next) {
  if (req.apiToken) return res.status(403).json({ error: 'Это действие недоступно по API-токену' });
  next();
}

export const hasRole = (user, role) => ROLES.indexOf(user.role) >= ROLES.indexOf(role);

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user && hasRole(req.user, role)) return next();
    res.status(403).json({ error: 'Недостаточно прав для этого действия' });
  };
}
