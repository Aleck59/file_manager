import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Минимальное окружение, чтобы config.js загрузился без .env
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-test-'));
Object.assign(process.env, {
  APP_ORIGIN: 'https://files.example.com',
  SESSION_SECRET: 'x'.repeat(32),
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  S3_PREFIX: 'uploads/',
  DATA_DIR: dataDir,
  ADMIN_USERNAME: 'admin',
});
const { hashPassword, verifyPassword } = await import('../src/password.js');
process.env.ADMIN_PASSWORD_HASH = await hashPassword('admin-password');

const keys = await import('../src/keys.js');
const users = await import('../src/users.js');
const auth = await import('../src/auth.js');

test('generateKey: валидный ключ в папке, кириллица сохраняется', () => {
  const key = keys.generateKey('Отчёт 2026.pdf', 'Документы/2026/');
  assert.ok(keys.isValidKey(key));
  assert.equal(keys.nameFromKey(key), 'Отчёт 2026.pdf');
  assert.equal(keys.folderFromKey(key), 'Документы/2026/');
});

test('новые ключи сортируются раньше старых', async () => {
  const older = keys.generateKey('a');
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(keys.generateKey('a') < older);
});

test('isValidKey отклоняет чужие и опасные ключи', () => {
  for (const key of ['secret/file', 'uploads/../x', 'uploads/abc~x', 'uploads/', '', null,
    'uploads/../2wqsre1rt-OVWOwbIfUMkMzvVC~a', 'other/2wqsre1rt-OVWOwbIfUMkMzvVC~a']) {
    assert.equal(keys.isValidKey(key), false, String(key));
  }
});

test('isValidFolder', () => {
  assert.ok(keys.isValidFolder(''));
  assert.ok(keys.isValidFolder('Документы/2026/'));
  for (const f of ['a', '/a/', 'a//', '../', 'a/./', 'a\\b/', ' a/', 'a\u0000/', `${'x/'.repeat(25)}`]) {
    assert.equal(keys.isValidFolder(f), false, JSON.stringify(f));
  }
});

test('sanitizeFileName / sanitizeFolderName', () => {
  assert.equal(keys.sanitizeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(keys.sanitizeFileName('a\u0000b\nc.txt'), 'a_b_c.txt');
  assert.equal(keys.sanitizeFileName('   '), 'file');
  assert.ok(keys.sanitizeFileName('я'.repeat(500) + '.txt').endsWith('.txt'));
  assert.equal(keys.sanitizeFolderName('../секрет'), '_секрет');
  assert.equal(keys.sanitizeFolderName('  '), null);
});

test('contentDisposition кодирует имя (attachment / inline)', () => {
  assert.equal(keys.contentDisposition('отчёт "1".pdf'),
    `attachment; filename="_____ _1_.pdf"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%221%22.pdf`);
  assert.ok(keys.contentDisposition('a.png', 'inline').startsWith('inline;'));
});

test('предпросмотр: HTML и SVG-исходники не отдаются как исполняемые', () => {
  assert.deepEqual(keys.previewKind('index.html'), { kind: 'text', contentType: 'text/plain; charset=utf-8' });
  assert.equal(keys.previewKind('photo.JPG').contentType, 'image/jpeg');
  assert.equal(keys.previewKind('setup.exe'), null);
});

test('safeContentType пропускает только валидные MIME', () => {
  assert.equal(keys.safeContentType('image/PNG'), 'image/png');
  assert.equal(keys.safeContentType('text/html\r\nX: y'), 'application/octet-stream');
});

test('scrypt-хеш пароля проверяется', async () => {
  const hash = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('пользователи: первый админ из .env, защита последнего админа', async () => {
  users.initUsers();
  assert.equal(users.getUser('ADMIN').role, 'admin');
  assert.ok(await auth.authenticate('admin', 'admin-password'));
  assert.equal(await auth.authenticate('admin', 'nope'), null);
  assert.equal(await auth.authenticate('ghost', 'admin-password'), null);
  assert.match(users.deleteUser('admin').error, /единственного/);
  assert.match(users.updateUser('admin', { role: 'viewer' }).error, /единственного/);
  assert.equal(users.normalizeUsername('Bad Name'), null);
});

test('сессия: токен привязан к паролю пользователя', async () => {
  users.createUser({ username: 'ivan', role: 'viewer', passwordHash: await hashPassword('ivan-password') });
  const token = auth.issueToken(users.getUser('ivan'));
  assert.equal(auth.userFromToken(token).username, 'ivan');
  assert.equal(auth.userFromToken(token.slice(0, -2) + 'xx'), null);
  users.updateUser('ivan', { passwordHash: await hashPassword('new-password-1') });
  assert.equal(auth.userFromToken(token), null, 'после смены пароля старый токен недействителен');
  users.deleteUser('ivan');
  assert.equal(auth.hasRole({ role: 'editor' }, 'viewer'), true);
  assert.equal(auth.hasRole({ role: 'editor' }, 'admin'), false);
});

test('rebuildKey: переименование и перемещение сохраняют id', () => {
  const key = keys.generateKey('черновик.txt', 'Документы/');
  const id = key.slice(key.lastIndexOf('/') + 1, key.indexOf('~'));
  const renamed = keys.rebuildKey(key, { name: 'Итог (v2).txt' });
  assert.equal(keys.nameFromKey(renamed), 'Итог (v2).txt');
  assert.equal(keys.folderFromKey(renamed), 'Документы/');
  const moved = keys.rebuildKey(renamed, { folder: '' });
  assert.equal(keys.folderFromKey(moved), '');
  assert.ok(moved.includes(`${id}~`));
  assert.ok(keys.isValidKey(renamed) && keys.isValidKey(moved));
  // Попытка выйти из папки через имя обезвреживается.
  assert.equal(keys.nameFromKey(keys.rebuildKey(key, { name: '../../etc/passwd' })), '_.._etc_passwd');
  assert.equal(keys.rebuildKey(key), key);
});

// ---------- настройки ----------
const cfg = await import('../src/config.js');

test('настройки: проверка значений', () => {
  assert.equal(cfg.parseField('PORT', '8080'), 8080);
  assert.throws(() => cfg.parseField('PORT', '70000'), /PORT/);
  assert.equal(cfg.parseField('APP_ORIGIN', 'https://files.example.com/path/'), 'https://files.example.com');
  assert.throws(() => cfg.parseField('APP_ORIGIN', 'ftp://x'), /http/);
  assert.equal(cfg.parseField('S3_PREFIX', '/files/'), 'files/');
  assert.throws(() => cfg.parseField('S3_PREFIX', 'a/../'), /S3_PREFIX/);
  assert.throws(() => cfg.parseField('S3_PREFIX', 'no-slash'), /S3_PREFIX/);
  assert.equal(cfg.parseField('S3_FORCE_PATH_STYLE', 'false'), false);
  assert.equal(cfg.parseField('S3_REGION', ''), 'us-east-1', 'пустое — значение по умолчанию');
});

test('настройки: изменение из интерфейса применяется сразу и сбрасывается к .env', () => {
  const seen = [];
  const off = cfg.onConfigChange((keys) => seen.push(...keys));
  cfg.updateSettings({ MAX_FILE_SIZE_MB: '10', S3_REGION: 'ru-central-1' });
  assert.equal(cfg.config.limits.maxFileSize, 10 * 1024 * 1024);
  assert.equal(cfg.config.s3.region, 'ru-central-1');
  assert.deepEqual(seen.sort(), ['MAX_FILE_SIZE_MB', 'S3_REGION']);
  const desc = Object.fromEntries(cfg.describeSettings().map((f) => [f.key, f]));
  assert.equal(desc.MAX_FILE_SIZE_MB.source, 'ui');
  assert.equal(desc.S3_SECRET_KEY.value, null, 'секрет не раскрывается');
  assert.equal(desc.S3_SECRET_KEY.isSet, true);
  // значение, совпадающее с .env, снимает переопределение
  cfg.updateSettings({ S3_BUCKET: 'bucket' });
  assert.equal(Object.fromEntries(cfg.describeSettings().map((f) => [f.key, f.source])).S3_BUCKET, 'env');
  cfg.resetSettings(['MAX_FILE_SIZE_MB', 'S3_REGION']);
  assert.equal(cfg.config.limits.maxFileSize, 5120 * 1024 * 1024);
  assert.equal(cfg.config.s3.region, 'us-east-1');
  // пустой секрет — «не менять»; некорректное значение — ошибка, ничего не меняется
  cfg.updateSettings({ S3_SECRET_KEY: '' });
  assert.equal(cfg.config.s3.secretAccessKey, 'b');
  assert.throws(() => cfg.updateSettings({ PORT: 'abc', MAX_FILE_SIZE_MB: '7' }), /PORT/);
  assert.equal(cfg.config.limits.maxFileSize, 5120 * 1024 * 1024);
  // HOST/PORT требуют перезапуска
  cfg.updateSettings({ PORT: '3999' });
  assert.equal(cfg.describeSettings().find((f) => f.key === 'PORT').restartPending, true);
  cfg.resetSettings(['PORT']);
  off();
});

test('настройки: секрет сессий создаётся автоматически и хранится с правами 600', () => {
  assert.ok(cfg.config.auth.sessionSecret.length >= 32);
  const mode = fs.statSync(cfg.settingsFilePath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

// ---------- HTTP-слой ----------
test('HTTP-слой: маршруты, параметры, вложенные роутеры, ошибки, JSON', async () => {
  const { createApp, json, Router } = await import('../src/http.js');
  const app = createApp({ trustProxy: () => 1 });
  const api = Router();
  api.use(json({ limit: 100 }));
  api.get('/items/:id', (req, res) => res.json({ id: req.params.id, q: req.query.q, ip: req.ip }));
  api.post('/echo', async (req, res) => res.status(201).json(req.body));
  api.get('/boom', async () => { throw Object.assign(new Error('x'), { status: 418 }); });
  app.use('/api', api);
  app.use((req, res) => res.status(404).send('nf'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.type ?? err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r1 = await (await fetch(`${base}/api/items/%D0%B0?q=1`, { headers: { 'x-forwarded-for': '1.2.3.4' } })).json();
    assert.deepEqual(r1, { id: 'а', q: '1', ip: '1.2.3.4' });
    const r2 = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.equal(r2.status, 201);
    assert.deepEqual(await r2.json(), { a: 1 });
    const r3 = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.deepEqual(await r3.json(), { error: 'entity.parse.failed' });
    const r4 = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(200) }) });
    assert.equal(r4.status, 500);
    assert.deepEqual(await r4.json(), { error: 'entity.too.large' });
    assert.equal((await fetch(`${base}/api/boom`)).status, 418);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});
