import { Router } from 'express';
import { checkPassword, clearSessionCookie, isAuthenticated, setSessionCookie } from '../auth.js';
import { rateLimit } from '../middleware/security.js';

export const authRouter = Router();

// 10 попыток входа за 15 минут с одного IP — защита от перебора пароля.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Слишком много попыток входа. Попробуйте через 15 минут.',
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string' || !password || password.length > 256) {
    return res.status(400).json({ error: 'Введите пароль' });
  }
  if (!(await checkPassword(password))) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  setSessionCookie(res);
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});
