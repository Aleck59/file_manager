// Аутентификация и авторизация.
// - Пароли хранятся только как scrypt-хеши.
// - Сессия — stateless-токен с HMAC-SHA256 в HttpOnly-cookie: в памяти ничего не хранится.
//   В подпись входит хеш пароля пользователя, поэтому смена пароля или удаление
//   пользователя сразу инвалидирует его сессии; смена SESSION_SECRET — все сессии.
import crypto from 'node:crypto';
import { config } from './config.js';
import { verifyPassword } from './password.js';
import { getUser, ROLES } from './users.js';

const { sessionSecret, sessionTtlSec } = config.auth;

export const COOKIE_NAME = config.secureCookies ? '__Host-fm_session' : 'fm_session';

// Хеш-пустышка: при несуществующем логине всё равно считаем scrypt,
// чтобы по времени ответа нельзя было понять, есть ли такой пользователь.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export async function authenticate(username, password) {
  const user = getUser(username);
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  return ok && user ? user : null;
}

function sign(payload, user) {
  return crypto.createHmac('sha256', sessionSecret).update(`${payload}|${user.passwordHash}`).digest('base64url');
}

export function issueToken(user) {
  const payload = `v2.${Buffer.from(user.username).toString('base64url')}.${Math.floor(Date.now() / 1000) + sessionTtlSec}`;
  return `${payload}.${sign(payload, user)}`;
}

// Возвращает пользователя по токену или null.
export function userFromToken(token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v2') return null;
  const [, nameB64, exp, sigB64] = parts;
  if (!(Number(exp) > Date.now() / 1000)) return null;
  const user = getUser(Buffer.from(nameB64, 'base64url').toString());
  if (!user) return null;
  const sig = Buffer.from(sigB64);
  const expected = Buffer.from(sign(parts.slice(0, 3).join('.'), user));
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
  return userFromToken(readCookie(req, COOKIE_NAME));
}

export function setSessionCookie(res, user) {
  res.cookie(COOKIE_NAME, issueToken(user), {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: sessionTtlSec * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/' });
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Требуется вход в систему' });
  req.user = user;
  next();
}

export const hasRole = (user, role) => ROLES.indexOf(user.role) >= ROLES.indexOf(role);

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user && hasRole(req.user, role)) return next();
    res.status(403).json({ error: 'Недостаточно прав для этого действия' });
  };
}
