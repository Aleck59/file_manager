// Конфигурация приложения.
//
// Источники значений (по возрастанию приоритета):
//   1. значения по умолчанию из описания полей ниже;
//   2. переменные окружения / файл .env;
//   3. изменения из интерфейса администратора — data/settings.json.
//
// Большинство настроек применяется сразу (config обновляется на месте, подписчики
// onConfigChange пересоздают S3-клиенты и т.п.). HOST и PORT требуют перезапуска.
//
// Хранилища S3 (их может быть несколько — они образуют единый диск) хранятся списком
// в data/settings.json. Переменные S3_* из .env используются только при первом запуске,
// чтобы создать первое хранилище «Основное».
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
  APP_NAME: { section: 'app', type: 'string', default: 'Файлообменник', maxLength: 40, apply: 'live' },
  TRUST_PROXY: { section: 'app', type: 'int', default: 1, min: 0, max: 10, apply: 'live' },
  HOST: { section: 'app', type: 'string', default: '127.0.0.1', apply: 'restart' },
  PORT: { section: 'app', type: 'int', default: 3000, min: 1, max: 65535, apply: 'restart' },

  SESSION_TTL_HOURS: { section: 'security', type: 'int', default: 12, min: 1, max: 720, apply: 'live' },
  SESSION_SECRET: { section: 'security', type: 'secret', minLength: 32, apply: 'live' },

  MAX_FILE_SIZE_MB: { section: 'limits', type: 'int', default: 5120, min: 1, max: 5 * 1024 * 1024, apply: 'live' },
  MULTIPART_THRESHOLD_MB: { section: 'limits', type: 'int', default: 64, min: 5, max: 5120, apply: 'live' },
  MULTIPART_PART_SIZE_MB: { section: 'limits', type: 'int', default: 16, min: 5, max: 5120, apply: 'live' },
  UPLOAD_URL_TTL_MIN: { section: 'limits', type: 'int', default: 60, min: 1, max: 7 * 24 * 60, apply: 'live' },
  TRASH_DAYS: { section: 'limits', type: 'int', default: 30, min: 0, max: 365, apply: 'live' },
};

// Поля одного хранилища S3 (и соответствующие переменные .env для первого запуска).
export const STORAGE_FIELDS = {
  name: { type: 'string', label: 'Название', maxLength: 60 },
  endpoint: { type: 'url', label: 'Адрес (endpoint)', env: 'S3_ENDPOINT', required: true },
  region: { type: 'string', label: 'Регион', default: 'us-east-1', env: 'S3_REGION' },
  bucket: { type: 'string', label: 'Бакет', env: 'S3_BUCKET', required: true },
  accessKeyId: { type: 'string', label: 'Access Key ID', env: 'S3_ACCESS_KEY', required: true },
  secretAccessKey: { type: 'secret', label: 'Secret Access Key', env: 'S3_SECRET_KEY', required: true },
  forcePathStyle: { type: 'bool', label: 'Path-style', default: true, env: 'S3_FORCE_PATH_STYLE' },
  prefix: { type: 'prefix', label: 'Папка в бакете', default: 'uploads/', env: 'S3_PREFIX' },
  quotaGb: { type: 'int', label: 'Квота, ГБ', default: 0, min: 0, max: 1_000_000 },
  acceptUploads: { type: 'bool', label: 'Принимать новые файлы', default: true },
  // Класс хранения (заголовок X-Amz-Storage-Class) для новых файлов: STANDARD, COLD, ICE,
  // SINGLE (Cloud.ru), STANDARD_IA (AWS) и т.п. Пусто — класс бакета по умолчанию.
  storageClass: { type: 'storageClass', label: 'Класс хранения', default: '' },
};
export const PLACEMENTS = ['fill', 'balance'];

// Только собственные ключи: FIELDS['constructor'] или FIELDS['toString'] — это свойства
// Object.prototype, их нельзя принимать за названия настроек.
export const isField = (key) => typeof key === 'string' && Object.hasOwn(FIELDS, key);

/** Приводит и проверяет значение поля. Бросает Error с понятным текстом. */
export function parseField(key, raw, f = FIELDS[key]) {
  // Пустая папка в бакете — это корень бакета, а не «значение по умолчанию».
  if (f.type === 'prefix' && typeof raw === 'string' && raw.trim().replace(/^\/+|\/+$/g, '') === '') return '';
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
    case 'storageClass':
      if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(str.toUpperCase())) throw new Error(`${key}: например STANDARD`);
      return str.toUpperCase();
    case 'prefix': {
      // Слеш на конце добавляем сами: «files» → «files/».
      const p = `${str.replace(/^\/+|\/+$/g, '')}/`;
      // eslint-disable-next-line no-control-regex
      if (p.includes('//') || /[\u0000-\u001f\\]/.test(p) || p.split('/').some((s) => s === '.' || s === '..')) {
        throw new Error(`${key}: путь вида «uploads/», без «..» и «//»`);
      }
      return p;
    }
    case 'secret':
      if (f.minLength && str.length < f.minLength) throw new Error(`${key}: не короче ${f.minLength} символов`);
      return str;
    default:
      if (str.length > (f.maxLength ?? 512)) throw new Error(`${key}: слишком длинное значение`);
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

const safeHost = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const isCloudRu = (endpoint) => /(^|\.)cloud\.ru$/.test(safeHost(endpoint));

// Cloud.ru применяет правила CORS только к адресам вида <бакет>.s3.cloud.ru: на path-style
// (s3.cloud.ru/<бакет>) предварительный запрос браузера получает «Access Denied», и загрузка
// падает с «Нет ответа от S3». Поэтому для Cloud.ru — всегда virtual-hosted (кроме бакетов с
// точкой в имени: для них не подойдёт TLS-сертификат *.s3.cloud.ru).
const fixAddressing = (def) => (isCloudRu(def.endpoint) && def.forcePathStyle && !String(def.bucket).includes('.')
  ? { ...def, forcePathStyle: false } : def);

// ---------- переопределения и хранилища из интерфейса ----------
let overrides = {};
let storages = null; // null — список ещё не создавался (первый запуск или старая версия)
let placement = 'fill';
const legacyS3 = {}; // S3_* из settings.json прошлой версии (одно хранилище) — для переноса
if (fs.existsSync(settingsFile)) {
  try {
    const file = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (Array.isArray(file.storages)) {
      // Хранилища из версий до появления «класса хранения»: для Cloud.ru — STANDARD
      // (нужный класс по умолчанию), для остальных — класс бакета.
      storages = file.storages.map((s) => fixAddressing(s.storageClass !== undefined ? s
        : { ...s, storageClass: isCloudRu(s.endpoint) ? 'STANDARD' : '' }));
    }
    if (PLACEMENTS.includes(file.placement)) placement = file.placement;
    const raw = file.overrides ?? {};
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith('S3_')) { legacyS3[key] = value; continue; }
      if (!isField(key)) continue;
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
  fs.writeFileSync(tmp, JSON.stringify({ overrides, storages, placement }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, settingsFile);
}

// ---------- хранилища ----------
const newStorageId = () => crypto.randomBytes(5).toString('hex').slice(0, 8);

/**
 * Проверяет описание хранилища. Пустой секрет означает «оставить прежний» (existing).
 * @returns {object} нормализованное описание
 */
export function parseStorageDef(input, existing = null) {
  const def = { id: existing?.id ?? newStorageId() };
  const errors = [];
  for (const [key, f] of Object.entries(STORAGE_FIELDS)) {
    let raw = input?.[key];
    if (raw === undefined && existing) raw = existing[key];
    if (f.type === 'secret' && (raw === undefined || raw === null || raw === '') && existing) raw = existing[key];
    try {
      const value = parseField(f.label, raw, f);
      if (f.required && (value === null || value === '')) throw new Error(`${f.label}: обязательное поле`);
      def[key] = value;
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (!def.name) def.name = def.bucket || 'Хранилище';
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400 });
  return fixAddressing(def);
}

// Первый запуск или обновление со старой версии: одно хранилище из .env / прежних настроек.
if (storages === null) {
  const seed = {};
  for (const [key, f] of Object.entries(STORAGE_FIELDS)) {
    if (f.env) seed[key] = legacyS3[f.env] ?? process.env[f.env];
  }
  storages = [];
  if (seed.endpoint && seed.bucket && seed.accessKeyId && seed.secretAccessKey) {
    try {
      storages.push({ ...parseStorageDef({ ...seed, name: 'Основное' }), id: 'main' });
    } catch (err) {
      throw new Error(`Ошибка в параметрах S3 (.env): ${err.message}`);
    }
  }
  if (fs.existsSync(settingsFile) || storages.length) persist();
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
  storages: [],
  placement: 'fill',
};

function apply(v) {
  if (!v.APP_ORIGIN) throw new Error('Не задан APP_ORIGIN — публичный адрес сайта, например https://files.example.com (см. .env.example)');
  config.appOrigin = v.APP_ORIGIN;
  config.appName = v.APP_NAME;
  // Secure-cookie только по HTTPS; для локальной разработки по http выключается автоматически.
  config.secureCookies = v.APP_ORIGIN.startsWith('https:');
  config.trustProxy = v.TRUST_PROXY;
  config.host = v.HOST;
  config.port = v.PORT;
  config.auth.sessionSecret = v.SESSION_SECRET;
  config.auth.sessionTtlSec = v.SESSION_TTL_HOURS * 3600;
  config.storages = storages;
  config.placement = placement;
  config.s3Configured = storages.length > 0;
  config.limits = {
    maxFileSize: v.MAX_FILE_SIZE_MB * MB,
    // Файлы больше порога грузятся multipart-ом (частями), меньше — одним PUT.
    multipartThreshold: v.MULTIPART_THRESHOLD_MB * MB,
    partSize: v.MULTIPART_PART_SIZE_MB * MB,
    uploadUrlTtlSec: v.UPLOAD_URL_TTL_MIN * 60,
    trashDays: v.TRASH_DAYS,
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
    if (!isField(key)) continue;
    const f = FIELDS[key];
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
  for (const key of keys) if (isField(key) && FIELDS[key].type !== 'secret') values[key] = envValues[key] ?? FIELDS[key].default ?? '';
  // Секреты сбрасываются только удалением переопределения.
  const secretKeys = keys.filter((k) => isField(k) && FIELDS[k].type === 'secret' && overrides[k] !== undefined && envValues[k]);
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

// ---------- управление хранилищами ----------
function storagesChanged() {
  apply(effective());
  persist();
  for (const fn of listeners) fn(['STORAGES']);
}

/** Описание хранилища для интерфейса: без секретного ключа. */
export function publicStorage(def) {
  const { secretAccessKey, ...rest } = def;
  return { ...rest, hasSecret: Boolean(secretAccessKey) };
}

export function findStorageDef(id) {
  return storages.find((s) => s.id === id) ?? null;
}

export function addStorage(input) {
  const def = parseStorageDef(input);
  while (findStorageDef(def.id)) def.id = newStorageId();
  storages = [...storages, def];
  storagesChanged();
  return def;
}

export function updateStorage(id, input) {
  const existing = findStorageDef(id);
  if (!existing) throw Object.assign(new Error('Хранилище не найдено'), { status: 404 });
  const def = parseStorageDef(input, existing);
  storages = storages.map((s) => (s.id === id ? def : s));
  storagesChanged();
  return def;
}

export function removeStorage(id) {
  if (!findStorageDef(id)) throw Object.assign(new Error('Хранилище не найдено'), { status: 404 });
  storages = storages.filter((s) => s.id !== id);
  storagesChanged();
}

/** Новый порядок хранилищ (важен для политики «заполнять по порядку»). */
export function reorderStorages(ids) {
  if (!Array.isArray(ids) || ids.length !== storages.length || !storages.every((s) => ids.includes(s.id))) {
    throw Object.assign(new Error('Некорректный порядок хранилищ'), { status: 400 });
  }
  storages = ids.map((id) => findStorageDef(id));
  storagesChanged();
}

// ---------- перенос настроек на другой сервер ----------
// Секрет сессий не переносится никогда; ключи S3 — только по явному выбору.
// Адрес сайта не импортируется: на новом сервере он свой, а смена заблокировала бы вход.
const NOT_IMPORTED = new Set(['APP_ORIGIN', 'SESSION_SECRET']);

export function exportSettings({ secrets = false } = {}) {
  const settings = {};
  for (const [key, value] of Object.entries(overrides)) if (key !== 'SESSION_SECRET') settings[key] = value;
  return {
    format: 'file-manager-settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    withSecrets: Boolean(secrets),
    settings,
    placement,
    storages: storages.map((def) => (secrets ? { ...def } : publicStorageForExport(def))),
  };
}
const publicStorageForExport = (def) => {
  const { secretAccessKey, ...rest } = def;
  return rest;
};

/**
 * Применяет файл экспорта. Хранилища сопоставляются по id: существующее обновляется
 * (пустой ключ — прежний), новое добавляется, только если в файле есть секретный ключ.
 * @returns {{ settings: string[], added: string[], updated: string[], skipped: string[] }}
 */
export function importSettings(data) {
  if (data?.format !== 'file-manager-settings' || data.version !== 1) {
    throw Object.assign(new Error('Это не файл настроек файлообменника'), { status: 400 });
  }
  const report = { settings: [], added: [], updated: [], skipped: [] };
  const values = {};
  for (const [key, value] of Object.entries(data.settings ?? {})) {
    if (isField(key) && !NOT_IMPORTED.has(key)) values[key] = value;
  }
  if (Object.keys(values).length) report.settings = updateSettings(values);
  const list = Array.isArray(data.storages) ? data.storages.slice(0, 50) : [];
  for (const input of list) {
    const name = String(input?.name ?? input?.bucket ?? 'хранилище').slice(0, 60);
    const existing = typeof input?.id === 'string' ? findStorageDef(input.id) : null;
    if (existing) {
      updateStorage(existing.id, { ...input, secretAccessKey: input.secretAccessKey ?? '' });
      report.updated.push(name);
    } else if (input?.secretAccessKey) {
      const def = parseStorageDef(input);
      if (typeof input.id === 'string' && /^[a-z0-9]{1,24}$/.test(input.id)) def.id = input.id; // ссылки на файлы сохранятся
      while (findStorageDef(def.id)) def.id = newStorageId();
      storages = [...storages, def];
      storagesChanged();
      report.added.push(name);
    } else {
      report.skipped.push(name);
    }
  }
  if (PLACEMENTS.includes(data.placement) && data.placement !== placement) setPlacement(data.placement);
  return report;
}

export function setPlacement(value) {
  if (!PLACEMENTS.includes(value)) throw Object.assign(new Error('Неизвестная политика размещения'), { status: 400 });
  placement = value;
  storagesChanged();
}
