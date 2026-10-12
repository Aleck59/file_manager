import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { currentUser, requireAuth, requireRole } from './auth.js';
import { errorHandler, rateLimit, sameOriginOnly, securityHeaders } from './middleware/security.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { settingsRouter } from './routes/settings.js';
import { usersRouter } from './routes/users.js';
import { initUsers } from './users.js';

initUsers();

const app = express();
const publicDir = path.join(config.root, 'public');

app.disable('x-powered-by');
// За Nginx: доверяем X-Forwarded-For от N прокси, чтобы req.ip был реальным IP клиента.
app.set('trust proxy', config.trustProxy);

app.use(securityHeaders);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// --- API ---
const api = express.Router();
api.use(express.json({ limit: '32kb' }));
api.use(sameOriginOnly);
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
api.use('/auth', authRouter);
api.use(requireAuth, rateLimit({ windowMs: 60 * 1000, max: 600 }));
api.use('/users', requireRole('admin'), usersRouter);
api.use('/settings', requireRole('admin'), settingsRouter);
api.use(filesRouter);
api.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
app.use('/api', api);

// --- Страницы ---
const sendPage = (file) => (req, res) =>
  res.set('Cache-Control', 'no-cache').sendFile(path.join(publicDir, file));

app.get(['/', '/index.html'], (req, res, next) =>
  currentUser(req) ? sendPage('index.html')(req, res, next) : res.redirect(302, '/login'),
);
app.get(['/login', '/login.html'], (req, res, next) =>
  currentUser(req) ? res.redirect(302, '/') : sendPage('login.html')(req, res, next),
);

app.use(express.static(publicDir, { index: false, maxAge: '1h' }));
app.use((req, res) => res.status(404).type('text').send('Not found'));
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`File manager запущен: http://${config.host}:${config.port} (публичный адрес ${config.appOrigin})`);
});

// Корректное завершение для PM2 / systemd.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
