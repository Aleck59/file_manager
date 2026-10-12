import { Router } from '../http.js';
import { authenticate, clearSessionCookie, currentToken, requireAuth, revokeToken, setSessionCookie } from '../auth.js';
import { config } from '../config.js';
import { HttpError, rateLimit } from '../middleware/security.js';
import { hashPassword, verifyPassword } from '../password.js';
import { getUser, publicUser, updateUser } from '../users.js';

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
    throw new HttpError(401, 'Неверный логин или пароль');
  }
  console.log(`[auth] вход: ${user.username} ip=${req.ip}`);
  setSessionCookie(res, user);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  const token = currentToken(req);
  if (token) revokeToken(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    storageConfigured: config.s3Configured,
    // Названия хранилищ единого диска (без параметров подключения).
    storages: config.storages.map((s) => ({ id: s.id, name: s.name })),
  });
});

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
