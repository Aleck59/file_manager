// Конфигурация приложения.
//
// Источники значений (по возрастанию приоритета):
//   1. значения по умолчанию из описания полей ниже;
//   2. переменные окружения / файл .env;
//   3. изменения из интерфейса администратора — data/settings.json.
//
// Большинство настроек применяется сразу (config обновляется на месте, подписчики
// onConfigChange пересоздают S3-клиент и т.п.). HOST и PORT требуют перезапуска.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const MB = 1024 * 1024;

// ---------- описание настраиваемых полей ----------
// type: origin | url | string | int | bool | secret | prefix
// apply: live — применяется сразу; restart — после перезапуска процесса
export const FIELDS = {
  APP_ORIGIN: { section: 'app', type: 'origin', apply: 'live' },
  TRUST_PROXY: { section: 'app', type: 'int', default: 1, min: 0, max: 10, apply: 'live' },
  HOST: { section: 'app', type: 'string', default: '127.0.0.1', apply: 'restart' },
  PORT: { section: 'app', type: 'int', default: 3000, min: 1, max: 65535, apply: 'restart' },

  SESSION_TTL_HOURS: { section: 'security', type: 'int', default: 12, min: 1, max: 720, apply: 'live' },
  SESSION_SECRET: { section: 'security', type: 'secret', minLength: 32, apply: 'live' },

  S3_ENDPOINT: { section: 's3', type: 'url', apply: 'live' },
  S3_REGION: { section: 's3', type: 'string', default: 'us-east-1', apply: 'live' },
  S3_BUCKET: { section: 's3', type: 'string', apply: 'live' },
  S3_ACCESS_KEY: { section: 's3', type: 'string', apply: 'live' },
  S3_SECRET_KEY: { section: 's3', type: 'secret', apply: 'live' },
  S3_FORCE_PATH_STYLE: { section: 's3', type: 'bool', default: true, apply: 'live' },
  S3_PREFIX: { section: 's3', type: 'prefix', default: 'uploads/', apply: 'live' },

  MAX_FILE_SIZE_MB: { section: 'limits', type: 'int', default: 5120, min: 1, max: 5 * 1024 * 1024, apply: 'live' },
  MULTIPART_THRESHOLD_MB: { section: 'limits', type: 'int', default: 64, min: 5, max: 5120, apply: 'live' },
  MULTIPART_PART_SIZE_MB: { section: 'limits', type: 'int', default: 16, min: 5, max: 5120, apply: 'live' },
  UPLOAD_URL_TTL_MIN: { section: 'limits', type: 'int', default: 60, min: 1, max: 7 * 24 * 60, apply: 'live' },
};

/** Приводит и проверяет значение поля. Бросает Error с понятным текстом. */
export function parseField(key, raw) {
  const f = FIELDS[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (f.default !== undefined) return f.default;
    return null;
  }
  const str = String(raw).trim();
  switch (f.type) {
    case 'int': {
      const n = typeof raw === 'number' ? raw : Number(str);
      if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(`${key}: целое число от ${f.min} до ${f.max}`);
      return n;
    }
    case 'bool':
      return typeof raw === 'boolean' ? raw : ['1', 'true', 'yes', 'on'].includes(str.toLowerCase());
    case 'origin':
    case 'url': {
      let u;
      try { u = new URL(str); } catch { throw new Error(`${key}: нужен полный адрес, например https://example.com`); }
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`${key}: допускаются только http и https`);
      return f.type === 'origin' ? u.origin : str.replace(/\/+$/, '');
    }
    case 'prefix': {
      const p = str.replace(/^\/+/, '');
      if (p === '') return '';
      // eslint-disable-next-line no-control-regex
      if (!p.endsWith('/') || p.includes('//') || /[\u0000-\u001f\\]/.test(p) || p.split('/').some((s) => s === '.' || s === '..')) {
        throw new Error(`${key}: путь вида «uploads/» — со слешем на конце, без «..» и «//»`);
      }
      return p;
    }
    case 'secret':
      if (f.minLength && str.length < f.minLength) throw new Error(`${key}: не короче ${f.minLength} символов`);
      return str;
    default:
      if (str.length > 512) throw new Error(`${key}: слишком длинное значение`);
      return str;
  }
}

// ---------- значения из окружения ----------
const envValues = {};
for (const key of Object.keys(FIELDS)) {
  try {
    envValues[key] = parseField(key, process.env[key]);
  } catch (err) {
    throw new Error(`Ошибка в .env: ${err.message}`);
  }
}

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const settingsFile = path.join(dataDir, 'settings.json');

// ---------- переопределения из интерфейса ----------
let overrides = {};
if (fs.existsSync(settingsFile)) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).overrides ?? {};
    for (const [key, value] of Object.entries(raw)) {
      if (!FIELDS[key]) continue;
      try {
        overrides[key] = parseField(key, value);
      } catch (err) {
        console.warn(`settings.json: значение ${key} проигнорировано — ${err.message}`);
      }
    }
  } catch (err) {
    throw new Error(`Не удалось прочитать ${settingsFile}: ${err.message}`);
  }
}

function persist() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${settingsFile}.${process.pid}.tmp`;
  // В файле есть секреты (ключ S3, секрет сессий) — доступ только владельцу.
  fs.writeFileSync(tmp, JSON.stringify({ overrides }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, settingsFile);
}

// Секрет сессий генерируется автоматически, если не задан ни в .env, ни ранее.
if (!envValues.SESSION_SECRET && !overrides.SESSION_SECRET) {
  overrides.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  persist();
}

const effective = () => ({ ...envValues, ...overrides });

// Хеш пароля первого администратора. Нужен только при первом запуске, пока не создан
// data/users.json; дальше пользователи управляются из интерфейса.
const bootstrapPasswordHash = process.env.ADMIN_PASSWORD_HASH?.trim() || null;
if (bootstrapPasswordHash && !bootstrapPasswordHash.startsWith('scrypt$')) {
  throw new Error('ADMIN_PASSWORD_HASH должен быть создан командой `npm run hash-password`');
}

// ---------- объект config (обновляется на месте) ----------
export const config = {
  root: ROOT,
  dataDir,
  auth: {
    bootstrapUsername: (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
    bootstrapPasswordHash,
  },
  limits: {},
  s3: {},
};

function apply(v) {
  if (!v.APP_ORIGIN) throw new Error('Не задан APP_ORIGIN — публичный адрес сайта, например https://files.example.com (см. .env.example)');
  config.appOrigin = v.APP_ORIGIN;
  // Secure-cookie только по HTTPS; для локальной разработки по http выключается автоматически.
  config.secureCookies = v.APP_ORIGIN.startsWith('https:');
  config.trustProxy = v.TRUST_PROXY;
  config.host = v.HOST;
  config.port = v.PORT;
  config.auth.sessionSecret = v.SESSION_SECRET;
  config.auth.sessionTtlSec = v.SESSION_TTL_HOURS * 3600;
  config.s3 = {
    endpoint: v.S3_ENDPOINT,
    region: v.S3_REGION,
    bucket: v.S3_BUCKET,
    accessKeyId: v.S3_ACCESS_KEY,
    secretAccessKey: v.S3_SECRET_KEY,
    forcePathStyle: v.S3_FORCE_PATH_STYLE,
    prefix: v.S3_PREFIX,
  };
  config.s3Configured = Boolean(v.S3_ENDPOINT && v.S3_BUCKET && v.S3_ACCESS_KEY && v.S3_SECRET_KEY);
  config.limits = {
    maxFileSize: v.MAX_FILE_SIZE_MB * MB,
    // Файлы больше порога грузятся multipart-ом (частями), меньше — одним PUT.
    multipartThreshold: v.MULTIPART_THRESHOLD_MB * MB,
    partSize: v.MULTIPART_PART_SIZE_MB * MB,
    uploadUrlTtlSec: v.UPLOAD_URL_TTL_MIN * 60,
    // SigV4 ограничивает срок жизни presigned-ссылки 7 днями.
    maxDownloadTtlSec: 7 * 24 * 3600,
  };
}
apply(effective());

// Значения, с которыми процесс реально запущен (для полей apply: 'restart').
const running = { HOST: config.host, PORT: config.port };

const listeners = new Set();
/** Подписка на изменение настроек: fn(changedKeys) */
export function onConfigChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Проверяет и сохраняет изменения. values: {KEY: значение}.
 * Пустой секрет означает «не менять». Значение, совпадающее с .env, снимает переопределение.
 * @returns {string[]} изменённые ключи
 */
export function updateSettings(values) {
  const next = { ...overrides };
  const errors = [];
  for (const [key, raw] of Object.entries(values)) {
    const f = FIELDS[key];
    if (!f) continue;
    if (f.type === 'secret' && (raw === undefined || raw === null || raw === '')) continue;
    try {
      const value = parseField(key, raw);
      if (value === envValues[key]) delete next[key];
      else next[key] = value;
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400 });

  const before = effective();
  const after = { ...envValues, ...next };
  apply(after); // бросит, если итоговая конфигурация некорректна
  overrides = next;
  persist();
  const changed = Object.keys(FIELDS).filter((k) => before[k] !== after[k]);
  for (const fn of listeners) fn(changed);
  return changed;
}

/** Сбрасывает переопределения — значения снова берутся из .env. */
export function resetSettings(keys) {
  const values = {};
  for (const key of keys) if (FIELDS[key] && FIELDS[key].type !== 'secret') values[key] = envValues[key] ?? FIELDS[key].default ?? '';
  // Секреты сбрасываются только удалением переопределения.
  const secretKeys = keys.filter((k) => FIELDS[k]?.type === 'secret' && overrides[k] !== undefined && envValues[k]);
  const changed = updateSettings(values);
  if (secretKeys.length) {
    for (const k of secretKeys) delete overrides[k];
    apply(effective());
    persist();
    for (const fn of listeners) fn(secretKeys);
  }
  return [...changed, ...secretKeys];
}

/** Описание настроек для интерфейса администратора. Секреты не раскрываются. */
export function describeSettings() {
  const v = effective();
  return Object.entries(FIELDS).map(([key, f]) => {
    const source = overrides[key] !== undefined ? 'ui' : process.env[key]?.trim() ? 'env' : 'default';
    const isSecret = f.type === 'secret';
    return {
      key, section: f.section, type: f.type, apply: f.apply,
      min: f.min, max: f.max, default: f.default,
      value: isSecret ? null : v[key],
      isSet: Boolean(v[key]),
      source,
      restartPending: f.apply === 'restart' && running[key] !== v[key],
    };
  });
}

export function settingsFilePath() {
  return settingsFile;
}
