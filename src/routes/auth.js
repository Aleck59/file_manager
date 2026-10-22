import { Router } from '../http.js';
import * as auditLog from '../audit-log.js';
import * as apiTokens from '../api-tokens.js';
import {
  authenticate, clearSessionCookie, currentToken, currentUser, hasRole, requireAuth, requireSession, revokeSession, revokeToken,
  sessionIdOf, setSessionCookie,
} from '../auth.js';
import * as sessions from '../sessions.js';
import { config } from '../config.js';
import * as storages from '../storages.js';
import { audit, HttpError, rateLimit } from '../middleware/security.js';
import { hashPassword, verifyPassword } from '../password.js';
import * as acl from '../acl.js';
import * as oauth from '../oauth.js';
import * as totp from '../totp.js';
import { findByEmail, getUser, isExpired, publicUser, updateUser } from '../users.js';
import { version } from '../version.js';

export const authRouter = Router();

export const MIN_PASSWORD_LENGTH = 10;

// 10 попыток входа за 15 минут с одного IP — защита от перебора пароля.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Слишком много попыток входа. Попробуйте через 15 минут.',
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || !username || username.length > 64 ||
      typeof password !== 'string' || !password || password.length > 256) {
    throw new HttpError(400, 'Введите логин и пароль');
  }
  const user = await authenticate(username, password);
  if (!user) {
    // Строка для fail2ban и разбора инцидентов. Логин — через JSON.stringify: перевод строки
    // в логине не сможет подделать запись в журнале.
    console.warn(`[auth] неудачный вход: логин=${JSON.stringify(username.slice(0, 64))} ip=${req.ip}`);
    auditLog.record({ user: username.slice(0, 64), action: 'auth.fail', ip: req.ip });
    throw new HttpError(401, 'Неверный логин или пароль');
  }
  if (isExpired(user)) {
    auditLog.record({ user: user.username, action: 'auth.fail', ip: req.ip, details: { reason: 'expired' } });
    throw new HttpError(403, 'Срок действия учётной записи истёк — обратитесь к администратору');
  }
  // Включена 2FA — сессию даст только второй шаг (код из приложения).
  if (user.totp) return res.json({ twoFactor: true, ticket: totp.issueTicket(user, 'password') });
  completeLogin(req, res, user, 'password');
  res.json({ user: publicUser(user) });
});

export function completeLogin(req, res, user, via, extra = {}) {
  console.log(`[auth] вход: ${user.username} (${via}) ip=${req.ip}`);
  auditLog.record({ user: user.username, action: 'auth.login', ip: req.ip, details: { via, ...extra, ua: String(req.headers['user-agent'] ?? '').slice(0, 160) } });
  setSessionCookie(res, user);
}

// ---------- двухфакторная аутентификация ----------
const twoFactorLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Слишком много попыток ввода кода. Попробуйте через 15 минут.' });

/** Проверяет код TOTP или код восстановления и сохраняет, что он использован. */
function checkSecondFactor(user, code) {
  const step = totp.verify(user.totp.secret, code, user.totp.lastStep ?? -1);
  if (step !== null) {
    updateUser(user.username, { totp: { ...user.totp, lastStep: step } });
    return 'totp';
  }
  const left = totp.useRecoveryCode(user.totp.recovery, code);
  if (left) {
    updateUser(user.username, { totp: { ...user.totp, recovery: left } });
    return 'recovery';
  }
  return null;
}

const TICKET_COOKIE = 'fm_2fa';
function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

// POST /api/auth/login/2fa {ticket?, code} — второй шаг входа. После входа через Яндекс/Google
// билет лежит в HttpOnly-cookie (страница входа его не видит).
authRouter.post('/login/2fa', twoFactorLimiter, (req, res) => {
  const t = totp.readTicket(req.body?.ticket ?? readCookie(req, TICKET_COOKIE), getUser);
  if (!t) throw new HttpError(401, 'Время на ввод кода истекло — войдите заново');
  const kind = checkSecondFactor(t.user, req.body?.code);
  if (!kind) {
    console.warn(`[auth] неверный код 2FA: ${t.user.username} ip=${req.ip}`);
    auditLog.record({ user: t.user.username, action: 'auth.fail', ip: req.ip, details: { reason: '2fa' } });
    throw new HttpError(401, 'Неверный код');
  }
  const user = getUser(t.user.username);
  res.clearCookie(TICKET_COOKIE, { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/' });
  completeLogin(req, res, user, t.via, { twoFactor: kind });
  res.json({ user: publicUser(user), recoveryLeft: kind === 'recovery' ? user.totp.recovery.length : undefined });
});

// ---------- вход через Яндекс / Google ----------
// GET /api/auth/oauth — какие провайдеры включены (для страницы входа)
authRouter.get('/oauth', (req, res) => res.json({ providers: oauth.enabledProviders() }));

const oauthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Слишком много попыток входа. Попробуйте через 15 минут.' });
const cookieOpts = (maxAge) => ({ httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/', ...(maxAge && { maxAge }) });

// Переход дальше страницей с meta refresh, а не 302: после возврата с сайта провайдера
// браузер не прислал бы cookie сессии (SameSite=Strict) на запрос из той же цепочки переходов.
function goTo(res, url) {
  const safe = url.replace(/[^\w/?=&.%-]/g, '');
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>Вход…</title><a href="${safe}">Продолжить</a>`);
}

authRouter.get('/oauth/:provider', oauthLimiter, (req, res) => {
  const id = req.params.provider;
  if (!oauth.isProvider(id)) throw new HttpError(404, 'Этот способ входа не настроен');
  const { url, cookie, maxAge } = oauth.start(id);
  res.cookie(oauth.COOKIE, cookie, cookieOpts(maxAge));
  res.redirect(302, url);
});

authRouter.get('/oauth/:provider/callback', oauthLimiter, async (req, res) => {
  const id = req.params.provider;
  if (!oauth.isProvider(id)) throw new HttpError(404, 'Этот способ входа не настроен');
  res.clearCookie(oauth.COOKIE, cookieOpts());
  let result;
  try {
    result = await oauth.finish(id, req.query, readCookie(req, oauth.COOKIE));
  } catch (err) {
    console.warn(`[oauth ${id}] ${err.code ?? 'error'}: ${err.message} ip=${req.ip}`);
    if (err.code !== 'denied') auditLog.record({ user: '-', action: 'auth.fail', ip: req.ip, details: { via: id, reason: err.code ?? 'error' } });
    return goTo(res, `/login?error=${encodeURIComponent(err.code ?? 'failed')}`);
  }
  const user = findByEmail(result.email);
  if (!user) {
    console.warn(`[oauth ${id}] нет пользователя с почтой ${JSON.stringify(result.email)} ip=${req.ip}`);
    auditLog.record({ user: result.email, action: 'auth.fail', ip: req.ip, details: { via: id, reason: 'nouser' } });
    return goTo(res, '/login?error=nouser');
  }
  if (isExpired(user)) return goTo(res, '/login?error=expired');
  if (user.totp) {
    res.cookie(TICKET_COOKIE, totp.issueTicket(user, id), cookieOpts(5 * 60 * 1000));
    return goTo(res, '/login?step=2fa');
  }
  completeLogin(req, res, user, id);
  goTo(res, '/');
});

// POST /api/auth/2fa/setup → {secret, uri} — новый секрет (ещё не включён)
authRouter.post('/2fa/setup', requireAuth, requireSession, (req, res) => {
  if (req.user.totp) throw new HttpError(400, 'Двухфакторная аутентификация уже включена');
  const secret = totp.newSecret();
  updateUser(req.user.username, { totpPending: { secret, at: Date.now() } });
  res.json({ secret, uri: totp.otpauthUri(secret, req.user.username) });
});

// POST /api/auth/2fa/enable {code} → {recoveryCodes}
authRouter.post('/2fa/enable', requireAuth, requireSession, twoFactorLimiter, (req, res) => {
  const pending = req.user.totpPending;
  if (!pending || Date.now() - pending.at > 30 * 60 * 1000) throw new HttpError(400, 'Начните настройку заново');
  const step = totp.verify(pending.secret, req.body?.code);
  if (step === null) throw new HttpError(400, 'Код не подошёл — проверьте время на телефоне и введите новый код');
  const { codes, hashes } = totp.recoveryCodes();
  updateUser(req.user.username, { totp: { secret: pending.secret, lastStep: step, recovery: hashes, enabledAt: new Date().toISOString() }, totpPending: null });
  audit(req, 'user.2fa', { enabled: true });
  res.json({ ok: true, recoveryCodes: codes });
});

async function requirePassword(req) {
  if (typeof req.body?.password !== 'string' || !(await verifyPassword(req.body.password, req.user.passwordHash))) {
    throw new HttpError(400, 'Пароль указан неверно');
  }
}

// POST /api/auth/2fa/disable {password}
authRouter.post('/2fa/disable', requireAuth, requireSession, loginLimiter, async (req, res) => {
  await requirePassword(req);
  updateUser(req.user.username, { totp: null, totpPending: null });
  audit(req, 'user.2fa', { enabled: false });
  res.json({ ok: true });
});

// POST /api/auth/2fa/recovery {password} → новые коды восстановления (старые сгорают)
authRouter.post('/2fa/recovery', requireAuth, requireSession, loginLimiter, async (req, res) => {
  if (!req.user.totp) throw new HttpError(400, 'Двухфакторная аутентификация не включена');
  await requirePassword(req);
  const { codes, hashes } = totp.recoveryCodes();
  updateUser(req.user.username, { totp: { ...req.user.totp, recovery: hashes } });
  audit(req, 'user.2fa', { recoveryCodes: 'обновлены' });
  res.json({ recoveryCodes: codes });
});

authRouter.post('/logout', (req, res) => {
  const token = currentToken(req);
  const user = currentUser(req);
  if (token) revokeToken(token);
  if (user) auditLog.record({ user: user.username, action: 'auth.logout', ip: req.ip });
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  // Личная папка создаётся при первом входе после включения настройки.
  const created = acl.ensurePersonal(req.user);
  if (created && config.s3Configured) await storages.createFolder(created).catch(() => {});
  res.json({
    user: publicUser(req.user),
    personal: acl.hasPersonal(req.user) ? { path: acl.personalPath(req.user.username), quotaMb: req.user.quotaMb ?? 0 } : null,
    // Версия (номер, коммит, ветка) — администратору, внизу «Настроек».
    ...(acl.isAdmin(req.user) && { version }),
    // Корень диска в интерфейсе: личная папка или весь диск.
    home: acl.homeOf(req.user),
    storageConfigured: config.s3Configured,
    // Названия хранилищ единого диска (без параметров подключения).
    storages: config.storages.map((s) => ({ id: s.id, name: s.name })),
    // Сколько дней удалённое лежит в корзине (0 — удаляется сразу).
    trashDays: config.limits.trashDays,
    // Администратору — расхождение часов сервера с хранилищами (для предупреждения).
    clockSkew: hasRole(req.user, 'admin') ? clockSkew() : undefined,
  });
});

function clockSkew() {
  const out = [];
  let list = [];
  try { list = storages.all(); } catch { /* хранилища ещё не подключены */ }
  for (const st of list) {
    const sec = Math.round(st.clockOffsetMs / 1000);
    if (Math.abs(sec) >= 60) out.push({ storage: st.name, offsetSec: sec });
  }
  return out;
}

// Смена собственного пароля. После неё выдаём новую cookie — старые сессии
// (на других устройствах) становятся недействительными.
authRouter.post('/password', requireAuth, loginLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, req.user.passwordHash))) {
    throw new HttpError(400, 'Текущий пароль указан неверно');
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 256) {
    throw new HttpError(400, `Новый пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`);
  }
  const result = updateUser(req.user.username, { passwordHash: await hashPassword(newPassword) });
  if (result.error) throw new HttpError(result.status ?? 400, result.error);
  setSessionCookie(res, getUser(req.user.username));
  res.json({ ok: true });
});

// ---------- сессии: где выполнен вход ----------
authRouter.get('/sessions', requireAuth, requireSession, (req, res) => {
  const current = sessionIdOf(currentToken(req));
  res.json({ sessions: sessions.listFor(req.user).map((x) => ({ ...x, current: x.id === current })) });
});

// DELETE /api/auth/sessions/:id — завершить сессию (свою; текущую — через «Выйти»)
authRouter.delete('/sessions/:id', requireAuth, requireSession, (req, res) => {
  if (req.params.id === sessionIdOf(currentToken(req))) throw new HttpError(400, 'Это текущая сессия — для неё нажмите «Выйти»');
  if (!revokeSession(req.user, req.params.id)) throw new HttpError(404, 'Сессия не найдена');
  audit(req, 'session.revoke', { count: 1 });
  res.json({ ok: true });
});

// POST /api/auth/sessions/revoke-others — выйти на всех остальных устройствах
authRouter.post('/sessions/revoke-others', requireAuth, requireSession, (req, res) => {
  const current = sessionIdOf(currentToken(req));
  let count = 0;
  for (const x of sessions.listFor(req.user)) if (x.id !== current && revokeSession(req.user, x.id)) count++;
  audit(req, 'session.revoke', { count });
  res.json({ ok: true, count });
});

// ---------- API-токены ----------
authRouter.get('/tokens', requireAuth, requireSession, (req, res) => {
  res.json({ tokens: apiTokens.listFor(req.user.username) });
});

authRouter.post('/tokens', requireAuth, requireSession, (req, res) => {
  try {
    const { token, info } = apiTokens.create(req.user.username, { name: req.body?.name, readOnly: req.body?.readOnly === true });
    audit(req, 'token.create', { name: info.name, readOnly: info.readOnly });
    res.status(201).json({ token, info });
  } catch (err) {
    throw new HttpError(err.status ?? 400, err.message);
  }
});

authRouter.delete('/tokens/:id', requireAuth, requireSession, (req, res) => {
  if (!apiTokens.revoke(req.user.username, req.params.id)) throw new HttpError(404, 'Токен не найден');
  audit(req, 'token.revoke', { id: req.params.id });
  res.json({ ok: true });
});
