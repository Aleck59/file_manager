// Загрузка и валидация конфигурации. Приложение падает при старте,
// если обязательные переменные не заданы — лучше сразу, чем в рантайме.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
  }
  return value.trim();
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Переменная ${name} должна быть целым числом в диапазоне ${min}..${max}`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const MB = 1024 * 1024;

const appOrigin = required('APP_ORIGIN').replace(/\/+$/, '');
let parsedOrigin;
try {
  parsedOrigin = new URL(appOrigin);
} catch {
  throw new Error('APP_ORIGIN должен быть полным URL, например https://files.example.com');
}

const sessionSecret = required('SESSION_SECRET');
if (sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET должен быть не короче 32 символов (openssl rand -hex 32)');
}

const passwordHash = required('ADMIN_PASSWORD_HASH');
if (!passwordHash.startsWith('scrypt$')) {
  throw new Error('ADMIN_PASSWORD_HASH должен быть создан командой `npm run hash-password`');
}

export const config = Object.freeze({
  root: ROOT,
  host: process.env.HOST || '127.0.0.1',
  port: int('PORT', 3000, { min: 1, max: 65535 }),
  appOrigin,
  // Secure-cookie только по HTTPS; для локальной разработки по http выключается автоматически.
  secureCookies: parsedOrigin.protocol === 'https:',
  trustProxy: int('TRUST_PROXY', 1, { min: 0, max: 10 }),

  auth: {
    passwordHash,
    sessionSecret,
    sessionTtlSec: int('SESSION_TTL_HOURS', 12, { min: 1, max: 24 * 30 }) * 3600,
  },

  s3: {
    endpoint: required('S3_ENDPOINT'),
    region: process.env.S3_REGION || 'us-east-1',
    bucket: required('S3_BUCKET'),
    accessKeyId: required('S3_ACCESS_KEY'),
    secretAccessKey: required('S3_SECRET_KEY'),
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
    prefix: (process.env.S3_PREFIX ?? 'uploads/').replace(/^\/+/, ''),
  },

  limits: {
    maxFileSize: int('MAX_FILE_SIZE_MB', 5120, { min: 1, max: 5 * 1024 * 1024 }) * MB,
    // Файлы больше порога грузятся multipart-ом (частями), меньше — одним PUT.
    multipartThreshold: int('MULTIPART_THRESHOLD_MB', 64, { min: 5, max: 5120 }) * MB,
    partSize: int('MULTIPART_PART_SIZE_MB', 16, { min: 5, max: 5120 }) * MB,
    uploadUrlTtlSec: int('UPLOAD_URL_TTL_MIN', 60, { min: 1, max: 7 * 24 * 60 }) * 60,
    // SigV4 ограничивает срок жизни presigned-ссылки 7 днями.
    maxDownloadTtlSec: 7 * 24 * 3600,
  },
});
