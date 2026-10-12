import path from 'node:path';
import { config } from './config.js';
import { currentUser, requireAuth, requireRole } from './auth.js';
import { createApp, json, Router, serveStatic } from './http.js';
import { errorHandler, rateLimit, sameOriginOnly, securityHeaders } from './middleware/security.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { settingsRouter } from './routes/settings.js';
import { usersRouter } from './routes/users.js';
import { initUsers } from './users.js';

initUsers();

// TRUST_PROXY меняется в настройках на лету — читаем при каждом запросе.
// За Nginx: доверяем X-Forwarded-For от N прокси, чтобы req.ip был реальным IP клиента.
const app = createApp({ trustProxy: () => config.trustProxy });
const publicDir = path.join(config.root, 'public');

app.use(securityHeaders);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// --- API ---
const api = Router();
api.use(json({ limit: 32 * 1024 }));
api.use(sameOriginOnly);
api.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
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
const page = (file) => (req, res) => res.sendFile(path.join(publicDir, file), { cacheControl: 'no-cache' });
const indexPage = page('index.html');
const loginPage = page('login.html');

app.get('/', (req, res) => (currentUser(req) ? indexPage(req, res) : res.redirect(302, '/login')));
app.get('/index.html', (req, res) => (currentUser(req) ? indexPage(req, res) : res.redirect(302, '/login')));
app.get('/login', (req, res) => (currentUser(req) ? res.redirect(302, '/') : loginPage(req, res)));
app.get('/login.html', (req, res) => (currentUser(req) ? res.redirect(302, '/') : loginPage(req, res)));

app.use(serveStatic(publicDir, { maxAge: 3600 }));
app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('Not found'));
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`File manager запущен: http://${config.host}:${config.port} (публичный адрес ${config.appOrigin})`);
  if (!config.s3Configured) console.log('Хранилище S3 не настроено — укажите его в интерфейсе: Настройки → Хранилище S3.');
});

export function shutdown(code = 0) {
  server.close(() => process.exit(code));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(code), 3000).unref();
}

// Корректное завершение для PM2 / systemd.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));
