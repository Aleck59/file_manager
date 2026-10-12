// Аутентификация одного администратора.
// - Пароль хранится только как scrypt-хеш (ADMIN_PASSWORD_HASH).
// - Сессия — stateless-токен с HMAC-SHA256 в HttpOnly-cookie: ничего не хранится в памяти,
//   что важно на VDS с маленьким объёмом ОЗУ. Смена пароля или SESSION_SECRET
//   мгновенно инвалидирует все выданные сессии.
import crypto from 'node:crypto';
import { config } from './config.js';
import { verifyPassword } from './password.js';

const { passwordHash, sessionSecret, sessionTtlSec } = config.auth;

export const COOKIE_NAME = config.secureCookies ? '__Host-fm_session' : 'fm_session';

export function checkPassword(password) {
  return verifyPassword(password, passwordHash);
}

function sign(payload) {
  // Хеш пароля входит в подпись — после смены пароля старые токены недействительны.
  return crypto.createHmac('sha256', sessionSecret).update(`${payload}|${passwordHash}`).digest('base64url');
}

export function issueToken() {
  const payload = `v1.${Math.floor(Date.now() / 1000) + sessionTtlSec}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return false;
  const payload = token.slice(0, idx);
  const sig = Buffer.from(token.slice(idx + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return false;
  const [version, exp] = payload.split('.');
  return version === 'v1' && Number(exp) > Date.now() / 1000;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function isAuthenticated(req) {
  return verifyToken(readCookie(req, COOKIE_NAME));
}

export function setSessionCookie(res) {
  res.cookie(COOKIE_NAME, issueToken(), {
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
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Требуется вход в систему' });
}
