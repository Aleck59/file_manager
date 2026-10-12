import { Router } from '../http.js';
import { authenticate, clearSessionCookie, requireAuth, setSessionCookie } from '../auth.js';
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
  if (!user) throw new HttpError(401, 'Неверный логин или пароль');
  setSessionCookie(res, user);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), storageConfigured: config.s3Configured });
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
