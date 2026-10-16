import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { currentUser, requireAuth, requireRole } from './auth.js';
import { createApp, json, Router, serveStatic } from './http.js';
import { branding, currentLogo, MAX_LOGO, saveLogo } from './branding.js';
import { audit, errorHandler, HttpError, rateLimit, sameOriginOnly, securityHeaders } from './middleware/security.js';
import * as apiTokens from './api-tokens.js';
import * as sessionsRegistry from './sessions.js';
import { adminRouter } from './routes/admin.js';
import { publicSharesRouter, sharesRouter } from './routes/shares.js';
import * as sharesStore from './shares.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { settingsRouter } from './routes/settings.js';
import { trashRouter } from './routes/trash.js';
import * as trash from './trash.js';
import { webdav } from './webdav.js';
import * as backup from './backup.js';
import * as folderIds from './folder-ids.js';
import * as labelsStore from './labels.js';
import * as commentsStore from './comments.js';
import { usersRouter } from './routes/users.js';
import { initUsers } from './users.js';

initUsers();

// TRUST_PROXY меняется в настройках на лету — читаем при каждом запросе.
// За Nginx: доверяем X-Forwarded-For от N прокси, чтобы req.ip был реальным IP клиента.
const app = createApp({ trustProxy: () => config.trustProxy });
const publicDir = path.join(config.root, 'public');

app.use(securityHeaders);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Логотип — публичный (нужен и на странице входа). Только растровые форматы, nosniff.
app.get('/branding/logo', (req, res) => {
  const logo = currentLogo();
  if (!logo) return res.status(404).type('text/plain; charset=utf-8').send('Not found');
  res.setHeader('Content-Type', logo.type);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(logo.file, { cacheControl: 'public, max-age=300' });
});

// Загрузка логотипа: base64 в JSON больше общего лимита API (32 КБ), поэтому — отдельный маршрут.
app.put('/api/settings/logo', json({ limit: Math.ceil(MAX_LOGO * 1.4) + 1024 }), sameOriginOnly, requireAuth, requireRole('admin'), (req, res) => {
  const data = req.body?.data;
  if (typeof data !== 'string') throw new HttpError(400, 'Нет файла');
  saveLogo(Buffer.from(data, 'base64'));
  audit(req, 'settings.update', { keys: ['LOGO'] });
  res.json(branding());
});

// --- API ---
const api = Router();
api.use(json({ limit: 32 * 1024 }));
api.use(sameOriginOnly);
api.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
api.use('/auth', authRouter);
// Название и логотип — без входа: их показывает и страница входа.
api.get('/branding', (req, res) => res.json(branding()));
// Публичные ссылки — без входа (у них свои ограничения и пароль).
api.use('/public/s', publicSharesRouter);
api.use(requireAuth, rateLimit({ windowMs: 60 * 1000, max: 600 }));
api.use('/users', requireRole('admin'), usersRouter);
api.use('/settings', requireRole('admin'), settingsRouter);
api.use('/admin', requireRole('admin'), adminRouter);
api.use('/shares', sharesRouter);
api.use('/trash', trashRouter);
api.use(filesRouter);
api.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
app.use('/api', api);

// --- Страницы ---
const page = (file) => (req, res) => res.sendFile(path.join(publicDir, file), { cacheControl: 'no-cache' });
const indexPage = page('index.html');
const loginPage = page('login.html');
const sharePage = page('share.html');

app.get('/', (req, res) => (currentUser(req) ? indexPage(req, res) : res.redirect(302, '/login')));
app.get('/index.html', (req, res) => (currentUser(req) ? indexPage(req, res) : res.redirect(302, '/login')));
app.get('/login', (req, res) => (currentUser(req) ? res.redirect(302, '/') : loginPage(req, res)));
app.get('/login.html', (req, res) => (currentUser(req) ? res.redirect(302, '/') : loginPage(req, res)));

// WebDAV: диск как сетевая папка (своя Basic-авторизация, см. webdav.js).
app.use('/dav', webdav);

// PWA: service worker — без долгого кеша (иначе обновления приходили бы с опозданием).
app.get('/sw.js', page('sw.js'));
// «Поделиться» без service worker (старый браузер, первый запуск) — просто открыть приложение.
app.post('/share-target', (req, res) => res.redirect(303, '/#/inbox'));

// Страница публичной ссылки: /s/<id> (данные она берёт из /api/public/s/<id>).
app.get('/s/:id', (req, res) => sharePage(req, res));

app.use(serveStatic(publicDir, { maxAge: 3600 }));
// Портал загрузки по короткому адресу: files.example.com/<адрес> (задаётся у ссылки).
app.get('/:slug', (req, res, next) => (sharesStore.get(req.params.slug)?.slug ? sharePage(req, res) : next()));
// Неизвестный адрес: браузеру — страница 404 с монстром, остальным — короткий текст.
const notFoundPage = fs.readFileSync(path.join(publicDir, '404.html'));
app.use((req, res) => {
  res.status(404);
  if ((req.method === 'GET' || req.method === 'HEAD') && (req.headers.accept ?? '').includes('text/html')) {
    res.setHeader('Cache-Control', 'no-store');
    return res.type('text/html; charset=utf-8').send(notFoundPage);
  }
  res.type('text/plain; charset=utf-8').send('Not found');
});
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`File manager запущен: http://${config.host}:${config.port} (публичный адрес ${config.appOrigin})`);
  trash.startAutoPurge();
  backup.startScheduler();
  if (!config.s3Configured) console.log('Хранилище S3 не настроено — укажите его в интерфейсе: Настройки → Хранилище S3.');
});

export function shutdown(code = 0) {
  sessionsRegistry.flush();
  sharesStore.flush();
  apiTokens.flush();
  labelsStore.flush();
  commentsStore.flush();
  folderIds.flush();
  server.close(() => process.exit(code));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(code), 3000).unref();
}

// Корректное завершение для PM2 / systemd.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));
