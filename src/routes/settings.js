// Настройки приложения (только для администратора).
// Все параметры из .env, кроме загрузочных (DATA_DIR, ADMIN_*), можно менять здесь.
// Изменения сохраняются в data/settings.json и применяются сразу; HOST и PORT — после перезапуска.
// Секреты (ключ S3, секрет сессий) наружу никогда не отдаются.
import crypto from 'node:crypto';
import { setSessionCookie } from '../auth.js';
import { config, describeSettings, FIELDS, parseField, resetSettings, settingsFilePath, updateSettings } from '../config.js';
import { Router } from '../http.js';
import { HttpError } from '../middleware/security.js';
import * as storage from '../s3.js';
import { getUser } from '../users.js';

export const settingsRouter = Router();

// Запущены ли мы под менеджером процессов, который поднимет приложение после выхода.
const supervised = Boolean(process.env.pm_id !== undefined || process.env.INVOCATION_ID || process.env.FM_SUPERVISED);

function payload() {
  return {
    fields: describeSettings(),
    readonly: {
      DATA_DIR: config.dataDir,
      ADMIN_USERNAME: config.auth.bootstrapUsername,
      settingsFile: settingsFilePath(),
    },
    s3Configured: config.s3Configured,
    supervised,
    memory: { rssMb: Math.round(process.memoryUsage().rss / 1048576) },
  };
}

settingsRouter.get('/', (req, res) => res.json(payload()));

// S3-параметры кандидата: присланные значения поверх текущих (пустой секрет — оставить текущий).
function candidateS3(values) {
  const pick = (key, current) => (values[key] === undefined || (FIELDS[key].type === 'secret' && !values[key])
    ? current : parseField(key, values[key]));
  const s3 = {
    endpoint: pick('S3_ENDPOINT', config.s3.endpoint),
    region: pick('S3_REGION', config.s3.region),
    bucket: pick('S3_BUCKET', config.s3.bucket),
    accessKeyId: pick('S3_ACCESS_KEY', config.s3.accessKeyId),
    secretAccessKey: pick('S3_SECRET_KEY', config.s3.secretAccessKey),
    forcePathStyle: pick('S3_FORCE_PATH_STYLE', config.s3.forcePathStyle),
  };
  const missing = [['S3_ENDPOINT', s3.endpoint], ['S3_BUCKET', s3.bucket], ['S3_ACCESS_KEY', s3.accessKeyId], ['S3_SECRET_KEY', s3.secretAccessKey]]
    .filter(([, v]) => !v).map(([k]) => k);
  return { s3, missing };
}

function readValues(req) {
  const values = req.body?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new HttpError(400, 'Нет значений для сохранения');
  return values;
}

// PUT /api/settings {values, skipCheck?, confirmOriginChange?}
settingsRouter.put('/', async (req, res) => {
  const values = readValues(req);

  // Смена APP_ORIGIN: с нового адреса изменяющие запросы со старого будут отклоняться.
  if (values.APP_ORIGIN !== undefined) {
    let next;
    try { next = parseField('APP_ORIGIN', values.APP_ORIGIN); } catch (err) { throw new HttpError(400, err.message); }
    if (next !== config.appOrigin && !req.body.confirmOriginChange) {
      throw new HttpError(409, 'Смена адреса сайта требует подтверждения');
    }
  }

  // Новые параметры S3 проверяем подключением до сохранения.
  const touchesS3 = Object.keys(values).some((k) => ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_FORCE_PATH_STYLE'].includes(k));
  if (touchesS3 && !req.body.skipCheck) {
    let candidate;
    try { candidate = candidateS3(values); } catch (err) { throw new HttpError(400, err.message); }
    if (!candidate.missing.length) {
      const check = await storage.testConnection(candidate.s3);
      if (!check.ok) return res.status(422).json({ error: `Не удалось подключиться к хранилищу — ${check.error}`, check });
    }
  }

  let changed;
  try {
    changed = updateSettings(values);
  } catch (err) {
    throw new HttpError(err.status ?? 400, err.message);
  }
  console.log(`[settings] ${req.user.username} изменил: ${changed.join(', ') || 'ничего'}`);
  res.json({ ...payload(), changed });
});

// POST /api/settings/reset {keys} — вернуть значения из .env
settingsRouter.post('/reset', (req, res) => {
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string' && FIELDS[k])) throw new HttpError(400, 'Некорректный список настроек');
  if (keys.includes('APP_ORIGIN') && !req.body.confirmOriginChange) throw new HttpError(409, 'Смена адреса сайта требует подтверждения');
  let changed;
  try {
    changed = resetSettings(keys);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  res.json({ ...payload(), changed });
});

// POST /api/settings/storage/check {values?} — проверка подключения (в т.ч. несохранённых значений)
settingsRouter.post('/storage/check', async (req, res) => {
  let candidate;
  try { candidate = candidateS3(req.body?.values ?? {}); } catch (err) { throw new HttpError(400, err.message); }
  if (candidate.missing.length) return res.json({ ok: false, error: `Не заполнено: ${candidate.missing.join(', ')}` });
  res.json(await storage.testConnection(candidate.s3));
});

// POST /api/settings/storage/cors — разрешить браузеру работать с бакетом с адреса сайта
settingsRouter.post('/storage/cors', async (req, res) => {
  try {
    await storage.putBucketCors(config.appOrigin);
    res.json({ ok: true, origin: config.appOrigin });
  } catch (err) {
    if (err.code === 'S3_NOT_CONFIGURED') throw err;
    console.error('PutBucketCors:', err.name, err.message);
    res.status(422).json({ error: `Хранилище не приняло правила CORS (${err.name}). Задайте их в панели провайдера — см. deploy/s3-cors.json.` });
  }
});

// POST /api/settings/sessions/reset — новый SESSION_SECRET: все сессии завершаются
settingsRouter.post('/sessions/reset', (req, res) => {
  updateSettings({ SESSION_SECRET: crypto.randomBytes(32).toString('hex') });
  setSessionCookie(res, getUser(req.user.username)); // текущий администратор остаётся в системе
  res.json({ ok: true });
});

// POST /api/settings/restart — перезапуск процесса (нужен для HOST/PORT).
// Работает, если приложение запущено через PM2, systemd или FastPanel: они поднимут его снова.
settingsRouter.post('/restart', (req, res) => {
  console.log(`[settings] перезапуск по запросу ${req.user.username}`);
  res.json({ ok: true, supervised });
  // SIGTERM → штатное завершение (server.js), менеджер процессов запустит приложение заново.
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300);
});
