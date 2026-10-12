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
  for (const key of ['secret/file', '../x', 'abc~x', 'a/', '', null,
    '../2wqsre1rt-OVWOwbIfUMkMzvVC~a', 'a/../2wqsre1rt-OVWOwbIfUMkMzvVC~a']) {
    assert.equal(keys.isValidKey(key), false, String(key));
  }
  assert.equal(keys.isValidKey('Документы/2wqsre1rt-OVWOwbIfUMkMzvVC~a.txt'), true);
});

test('ссылки на файл: «<хранилище>:<ключ>»', () => {
  const rel = keys.generateKey('a.txt', 'x/');
  const ref = keys.formatRef('main', rel);
  assert.deepEqual(keys.parseRef(ref), { storageId: 'main', rel });
  for (const bad of [rel, `:${rel}`, `Main:${rel}`, `a b:${rel}`, 'main:../x', 'main:', null, `${'a'.repeat(30)}:${rel}`]) {
    assert.equal(keys.parseRef(bad), null, String(bad));
  }
});

test('compareKeys: порядок как в S3 (байты UTF-8)', () => {
  // U+FF5E (BMP) > U+1F600 по UTF-16, но < по UTF-8 — как сортирует S3.
  assert.ok(keys.compareKeys('\uFF5E', '\u{1F600}') < 0);
  assert.ok('\uFF5E' > '\u{1F600}');
  assert.ok(keys.compareKeys('Документы/', 'Фото/') < 0);
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
  const prefix = cfg.STORAGE_FIELDS.prefix;
  assert.equal(cfg.parseField('prefix', '/files/', prefix), 'files/');
  assert.throws(() => cfg.parseField('prefix', 'a/../', prefix), /prefix/);
  assert.throws(() => cfg.parseField('prefix', 'no-slash', prefix), /prefix/);
  assert.equal(cfg.parseField('x', 'false', cfg.STORAGE_FIELDS.forcePathStyle), false);
  assert.equal(cfg.parseField('x', '', cfg.STORAGE_FIELDS.region), 'us-east-1', 'пустое — значение по умолчанию');
});

test('настройки: изменение из интерфейса применяется сразу и сбрасывается к .env', () => {
  const seen = [];
  const off = cfg.onConfigChange((keys) => seen.push(...keys));
  cfg.updateSettings({ MAX_FILE_SIZE_MB: '10', SESSION_TTL_HOURS: '24' });
  assert.equal(cfg.config.limits.maxFileSize, 10 * 1024 * 1024);
  assert.equal(cfg.config.auth.sessionTtlSec, 24 * 3600);
  assert.deepEqual(seen.sort(), ['MAX_FILE_SIZE_MB', 'SESSION_TTL_HOURS']);
  const desc = Object.fromEntries(cfg.describeSettings().map((f) => [f.key, f]));
  assert.equal(desc.MAX_FILE_SIZE_MB.source, 'ui');
  assert.equal(desc.SESSION_SECRET.value, null, 'секрет не раскрывается');
  assert.equal(desc.SESSION_SECRET.isSet, true);
  // значение, совпадающее с .env, снимает переопределение
  cfg.updateSettings({ SESSION_TTL_HOURS: '12' });
  assert.equal(Object.fromEntries(cfg.describeSettings().map((f) => [f.key, f.source])).SESSION_TTL_HOURS, 'default');
  cfg.resetSettings(['MAX_FILE_SIZE_MB']);
  assert.equal(cfg.config.limits.maxFileSize, 5120 * 1024 * 1024);
  // пустой секрет — «не менять»; некорректное значение — ошибка, ничего не меняется
  cfg.updateSettings({ SESSION_SECRET: '' });
  assert.equal(cfg.config.auth.sessionSecret, 'x'.repeat(32));
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

// ---------- хранилища ----------
test('хранилища: первое создаётся из S3_* в .env, секрет не раскрывается', () => {
  assert.equal(cfg.config.storages.length, 1);
  const main = cfg.config.storages[0];
  assert.deepEqual([main.id, main.name, main.bucket, main.prefix], ['main', 'Основное', 'bucket', 'uploads/']);
  const pub = cfg.publicStorage(main);
  assert.equal(pub.secretAccessKey, undefined);
  assert.equal(pub.hasSecret, true);
});

test('хранилища: добавление, изменение (пустой секрет — прежний), порядок, удаление', () => {
  const seen = [];
  const off = cfg.onConfigChange((k) => seen.push(...k));
  assert.throws(() => cfg.addStorage({ name: 'X' }), /обязательное/);
  const second = cfg.addStorage({ name: 'Cloud.ru', endpoint: 'https://s3.cloud.ru', region: 'ru-central-1',
    bucket: 'b2', accessKeyId: 'tenant:key', secretAccessKey: 's2', quotaGb: '100' });
  assert.match(second.id, /^[a-z0-9]{1,24}$/);
  assert.equal(second.quotaGb, 100);
  assert.equal(second.acceptUploads, true);
  const upd = cfg.updateStorage(second.id, { name: 'Cloud.ru архив', secretAccessKey: '', acceptUploads: false });
  assert.equal(upd.secretAccessKey, 's2', 'пустой секрет — оставить прежний');
  assert.equal(upd.acceptUploads, false);
  assert.equal(upd.bucket, 'b2');
  cfg.reorderStorages([second.id, 'main']);
  assert.deepEqual(cfg.config.storages.map((s) => s.id), [second.id, 'main']);
  assert.throws(() => cfg.reorderStorages(['main']), /порядок/);
  cfg.setPlacement('balance');
  assert.equal(cfg.config.placement, 'balance');
  assert.throws(() => cfg.setPlacement('random'), /политика/);
  cfg.removeStorage(second.id);
  cfg.setPlacement('fill');
  assert.deepEqual(cfg.config.storages.map((s) => s.id), ['main']);
  assert.ok(seen.includes('STORAGES'));
  const saved = JSON.parse(fs.readFileSync(cfg.settingsFilePath(), 'utf8'));
  assert.equal(saved.storages.length, 1);
  off();
});

const reg = await import('../src/storages.js');

test('единый диск: слияние страниц разных хранилищ — точный порядок и курсор', () => {
  const A = { id: 'a' }; const B = { id: 'b' };
  const f = (rel) => ({ rel, size: 1, lastModified: null });
  // ключи файлов сортируются «новые сверху»; папки — по имени; у обоих хранилищ есть «Фото/»
  const pages = [
    { st: A, page: { folders: ['Фото/'], files: [f('1~a'), f('3~c'), f('5~e')], truncated: true } },
    { st: B, page: { folders: ['Документы/', 'Фото/'], files: [f('2~b'), f('4~d')], truncated: false } },
  ];
  const p1 = reg.mergePages(pages, { limit: 4 });
  assert.deepEqual(p1.files.map((x) => `${x.st.id}:${x.rel}`), ['a:1~a', 'b:2~b', 'a:3~c', 'b:4~d']);
  assert.equal(p1.nextCursor, '4~d');
  assert.equal(p1.folders.length, 0, 'папки (кириллица) по байтам идут после цифр');
  // следующая страница: StartAfter = курсор; дубль папки, совпадающий с курсором, отбрасывается
  const p2 = reg.mergePages([
    { st: A, page: { folders: ['Фото/'], files: [f('5~e')], truncated: false } },
    { st: B, page: { folders: ['Документы/', 'Фото/'], files: [], truncated: false } },
  ], { cursor: '4~d', limit: 4 });
  assert.deepEqual(p2.files.map((x) => x.rel), ['5~e']);
  assert.deepEqual(p2.folders.map((x) => x.name), ['Документы', 'Фото'], 'одинаковые папки — одна');
  assert.equal(p2.nextCursor, null);
});

test('единый диск: выбор хранилища для нового файла', () => {
  const GB = 1024 ** 3;
  const c = [
    { id: 'a', quota: 10 * GB, used: 9.5 * GB, acceptUploads: true },
    { id: 'b', quota: 0, used: 50 * GB, acceptUploads: true },
    { id: 'c', quota: 100 * GB, used: 1 * GB, acceptUploads: true },
    { id: 'd', quota: 0, used: 0, acceptUploads: false },
  ];
  assert.equal(reg.choosePlacement(c, 0.1 * GB, 'fill').id, 'a', 'по порядку: первое с местом');
  assert.equal(reg.choosePlacement(c, 1 * GB, 'fill').id, 'b', 'в «a» не помещается');
  assert.equal(reg.choosePlacement(c, 1 * GB, 'balance').id, 'c', 'наименьшая заполненность');
  assert.equal(reg.choosePlacement([c[0], c[3]], 1 * GB, 'fill'), null, 'места нет нигде');
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

// ---------- безопасность (регрессионные тесты по итогам аудита) ----------
test('аудит: X-Forwarded-For принимается только от локального/частного прокси', async () => {
  const { isTrustedPeer } = await import('../src/http.js');
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.1', 'fd12::1']) {
    assert.equal(isTrustedPeer(a), true, a);
  }
  for (const a of ['192.0.2.2', '8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '2001:db8::1', '']) {
    assert.equal(isTrustedPeer(a), false, a);
  }
});

test('аудит: невидимые и bidi-символы вырезаются из имён, ZWJ в эмодзи сохраняется', () => {
  assert.equal(keys.sanitizeFileName('invoice‮fdp.exe'), 'invoicefdp.exe');
  assert.equal(keys.sanitizeFolderName('Док​ументы⁦'), 'Документы');
  assert.equal(keys.sanitizeFileName('﻿a.txt'), 'a.txt');
  assert.equal(keys.sanitizeFileName('👨‍👩‍👧.jpg'), '👨‍👩‍👧.jpg');
  assert.equal(keys.isValidFolder('a‮/'), false);
});

test('аудит: служебные ключи объекта не считаются настройками', () => {
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(cfg.isField(k), false, k);
  assert.equal(cfg.isField('PORT'), true);
  assert.throws(() => cfg.parseStorageDef({ name: 'x', endpoint: 'javascript:alert(1)', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }), /http/);
});

test('аудит: выход отзывает токен', () => {
  const user = users.getUser('admin');
  const token = auth.issueToken(user);
  assert.equal(auth.userFromToken(token)?.username, 'admin');
  auth.revokeToken(token);
  assert.equal(auth.userFromToken(token), null);
  assert.ok(auth.userFromToken(auth.issueToken(user)), 'новый вход работает');
  const mode = fs.statSync(path.join(dataDir, 'revoked.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('класс хранения: проверка значения и запись в presigned PUT', async () => {
  const f = cfg.STORAGE_FIELDS.storageClass;
  assert.equal(cfg.parseField('Класс', 'standard', f), 'STANDARD');
  assert.equal(cfg.parseField('Класс', '', f), '');
  assert.throws(() => cfg.parseField('Класс', 'COLD; rm', f));
  const { Storage } = await import('../src/s3.js');
  const st = new Storage({ ...cfg.config.storages[0], storageClass: 'STANDARD' });
  const { url, headers } = await st.presignPut('a~x.txt', 'text/plain', 3);
  // Класс — подписанный заголовок, а не параметр ссылки (его понимают не все хранилища).
  const u = new URL(url);
  assert.equal(u.searchParams.get('x-amz-storage-class'), null);
  assert.match(u.searchParams.get('X-Amz-SignedHeaders'), /x-amz-storage-class/);
  assert.equal(headers['X-Amz-Storage-Class'], 'STANDARD');
  st.destroy();
});

test('S3: PutBucketCors и DeleteObjects шлют Content-MD5 вместо CRC32', async () => {
  const http = await import('node:http');
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, h: req.headers });
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/xml');
      res.end(req.url.includes('delete') ? '<DeleteResult></DeleteResult>' : '');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { Storage } = await import('../src/s3.js');
  const st = new Storage({ ...cfg.config.storages[0], endpoint: `http://127.0.0.1:${srv.address().port}`, forcePathStyle: true });
  try {
    await st.putCors('https://files.example.com');
    await st.deleteMany(['a~x.txt']);
  } finally {
    st.destroy();
    srv.close();
  }
  assert.equal(seen.length, 2);
  for (const { h } of seen) {
    assert.match(h['content-md5'] ?? '', /^[A-Za-z0-9+/]{22}==$/);
    assert.ok(!Object.keys(h).some((k) => k.startsWith('x-amz-checksum-')));
    // Заголовок добавляется до подписи — иначе S3 ответит «headers … not signed».
    assert.match(h.authorization, /SignedHeaders=[^,]*content-md5/);
  }
});

test('Cloud.ru: всегда virtual-hosted (CORS работает только на <бакет>.s3.cloud.ru)', () => {
  const base = { endpoint: 'https://s3.cloud.ru', region: 'ru-central-1', accessKeyId: 't:k', secretAccessKey: 's', forcePathStyle: true };
  assert.equal(cfg.parseStorageDef({ ...base, bucket: 'bucket-cbd082' }).forcePathStyle, false);
  assert.equal(cfg.parseStorageDef({ ...base, bucket: 'with.dot' }).forcePathStyle, true, 'бакет с точкой — path-style (TLS)');
  assert.equal(cfg.parseStorageDef({ ...base, endpoint: 'https://storage.yandexcloud.net', bucket: 'b' }).forcePathStyle, true);
});
