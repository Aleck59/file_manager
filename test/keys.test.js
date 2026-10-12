import { test } from 'node:test';
import assert from 'node:assert/strict';

// Минимальное окружение, чтобы config.js загрузился без .env
Object.assign(process.env, {
  APP_ORIGIN: 'https://files.example.com',
  SESSION_SECRET: 'x'.repeat(32),
  ADMIN_PASSWORD_HASH: 'scrypt$16384$8$1$AAAA$AAAA',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  S3_PREFIX: 'uploads/',
});
const { generateKey, isValidKey, sanitizeFileName, contentDisposition, safeContentType } = await import('../src/keys.js');
const { hashPassword, verifyPassword } = await import('../src/password.js');

test('generateKey создаёт валидный ключ и сохраняет кириллицу', () => {
  const key = generateKey('Отчёт 2026.pdf');
  assert.ok(isValidKey(key));
  assert.ok(key.endsWith('/Отчёт 2026.pdf'));
});

test('новые ключи сортируются раньше старых', async () => {
  const older = generateKey('a');
  await new Promise((r) => setTimeout(r, 5));
  const newer = generateKey('a');
  assert.ok(newer < older);
});

test('isValidKey отклоняет чужие и опасные ключи', () => {
  for (const key of ['secret/file', 'uploads/../x', 'uploads/abc/x', 'uploads/', '', null, 'uploads/2wqsre1rt-OVWOwbIfUMkMzvVC/a/b']) {
    assert.equal(isValidKey(key), false, String(key));
  }
});

test('sanitizeFileName убирает разделители путей и управляющие символы', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFileName('a\u0000b\nc.txt'), 'a_b_c.txt');
  assert.equal(sanitizeFileName('   '), 'file');
  assert.ok(sanitizeFileName('я'.repeat(500) + '.txt').endsWith('.txt'));
});

test('contentDisposition всегда attachment и корректно кодирует имя', () => {
  assert.equal(contentDisposition('отчёт "1".pdf'),
    `attachment; filename="_____ _1_.pdf"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%221%22.pdf`);
});

test('safeContentType пропускает только валидные MIME', () => {
  assert.equal(safeContentType('image/PNG'), 'image/png');
  assert.equal(safeContentType('text/html\r\nX: y'), 'application/octet-stream');
  assert.equal(safeContentType(undefined), 'application/octet-stream');
});

test('scrypt-хеш пароля проверяется', async () => {
  const hash = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
});
