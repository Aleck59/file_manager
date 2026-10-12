// Настройки приложения (только для администратора).
// Все параметры из .env, кроме загрузочных (DATA_DIR, ADMIN_*), можно менять здесь.
// Изменения сохраняются в data/settings.json и применяются сразу; HOST и PORT — после перезапуска.
// Хранилища S3 (единый диск) — списком; секретные ключи наружу никогда не отдаются.
import crypto from 'node:crypto';
import { setSessionCookie } from '../auth.js';
import {
  addStorage, config, describeSettings, findStorageDef, isField, parseField, parseStorageDef, PLACEMENTS,
  publicStorage, removeStorage, reorderStorages, resetSettings, setPlacement, settingsFilePath, updateSettings, updateStorage,
} from '../config.js';
import { Router } from '../http.js';
import { HttpError } from '../middleware/security.js';
import { Storage, testConnection } from '../s3.js';
import * as storagesRegistry from '../storages.js';
import { getUser } from '../users.js';

export const settingsRouter = Router();

// Запущены ли мы под менеджером процессов, который поднимет приложение после выхода.
const supervised = Boolean(process.env.pm_id !== undefined || process.env.INVOCATION_ID || process.env.FM_SUPERVISED);

function payload() {
  return {
    fields: describeSettings(),
    storages: config.storages.map(publicStorage),
    placement: config.placement,
    placements: PLACEMENTS,
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

const wrap = (fn) => {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(err.status ?? 400, err.message);
  }
};

settingsRouter.get('/', (req, res) => res.json(payload()));

// PUT /api/settings {values, confirmOriginChange?}
settingsRouter.put('/', (req, res) => {
  const values = req.body?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new HttpError(400, 'Нет значений для сохранения');
  const unknown = Object.keys(values).filter((k) => !isField(k));
  if (unknown.length) throw new HttpError(400, `Неизвестные настройки: ${unknown.slice(0, 5).join(', ')}`);

  // Смена APP_ORIGIN: изменяющие запросы со старого адреса после этого будут отклоняться.
  if (values.APP_ORIGIN !== undefined) {
    const next = wrap(() => parseField('APP_ORIGIN', values.APP_ORIGIN));
    if (next !== config.appOrigin && !req.body.confirmOriginChange) {
      throw new HttpError(409, 'Смена адреса сайта требует подтверждения');
    }
  }
  const changed = wrap(() => updateSettings(values));
  console.log(`[settings] ${req.user.username} изменил: ${changed.join(', ') || 'ничего'}`);
  res.json({ ...payload(), changed });
});

// POST /api/settings/reset {keys} — вернуть значения из .env
settingsRouter.post('/reset', (req, res) => {
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || !keys.length || !keys.every(isField)) throw new HttpError(400, 'Некорректный список настроек');
  if (keys.includes('APP_ORIGIN') && !req.body.confirmOriginChange) throw new HttpError(409, 'Смена адреса сайта требует подтверждения');
  const changed = wrap(() => resetSettings(keys));
  res.json({ ...payload(), changed });
});

// ---------- хранилища ----------

// Кандидат: присланные значения поверх сохранённых (пустой секрет — оставить прежний).
function candidate(req) {
  const id = req.body?.id ?? req.params?.id;
  const existing = id ? findStorageDef(id) : null;
  if (id && !existing) throw new HttpError(404, 'Хранилище не найдено');
  return wrap(() => parseStorageDef(req.body?.storage ?? {}, existing));
}

async function ensureReachable(def, req) {
  if (req.body?.skipCheck) return null;
  const check = await testConnection(def);
  if (!check.ok) {
    const err = new HttpError(422, `Не удалось подключиться к «${def.name}» — ${check.error}`);
    err.check = check;
    throw err;
  }
  return check;
}

// Сразу после добавления/смены бакета разрешаем браузеру работать с ним (CORS).
async function applyCors(def) {
  const st = new Storage(def);
  try {
    await st.putCors(config.appOrigin);
    return { ok: true };
  } catch (err) {
    console.error(`[storage ${def.name}] PutBucketCors:`, err.name, err.message);
    return { ok: false, error: `${err.name}: хранилище не приняло правила CORS — задайте их в панели провайдера (deploy/s3-cors.json)` };
  } finally {
    st.destroy();
  }
}

// POST /api/settings/storages/check {id?, storage} — проверить подключение (в т.ч. несохранённое)
settingsRouter.post('/storages/check', async (req, res) => {
  let def;
  try {
    def = candidate(req);
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
  res.json(await testConnection(def));
});

// POST /api/settings/storages {storage, skipCheck?} — добавить хранилище
settingsRouter.post('/storages', async (req, res) => {
  const def = candidate({ body: { storage: req.body?.storage } });
  await ensureReachable(def, req);
  const saved = wrap(() => addStorage(req.body.storage));
  const cors = await applyCors(saved);
  console.log(`[settings] ${req.user.username} добавил хранилище «${saved.name}» (${saved.bucket})`);
  res.status(201).json({ ...payload(), storage: publicStorage(saved), cors });
});

// PUT /api/settings/storages/:id {storage, skipCheck?} — изменить хранилище
settingsRouter.put('/storages/:id', async (req, res) => {
  const before = findStorageDef(req.params.id);
  const def = candidate(req);
  const connectionChanged = ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'forcePathStyle']
    .some((k) => def[k] !== before[k]);
  if (connectionChanged) await ensureReachable(def, req);
  const saved = wrap(() => updateStorage(req.params.id, req.body?.storage ?? {}));
  const cors = connectionChanged ? await applyCors(saved) : null;
  res.json({ ...payload(), storage: publicStorage(saved), cors });
});

// DELETE /api/settings/storages/:id — отключить хранилище (файлы в бакете остаются)
settingsRouter.delete('/storages/:id', (req, res) => {
  const def = findStorageDef(req.params.id);
  wrap(() => removeStorage(req.params.id));
  console.log(`[settings] ${req.user.username} отключил хранилище «${def?.name}»`);
  res.json(payload());
});

// PUT /api/settings/storages-order {ids} — порядок (важен для политики «по порядку»)
settingsRouter.put('/storages-order', (req, res) => {
  wrap(() => reorderStorages(req.body?.ids));
  res.json(payload());
});

// PUT /api/settings/placement {placement} — куда класть новые файлы
settingsRouter.put('/placement', (req, res) => {
  wrap(() => setPlacement(req.body?.placement));
  res.json(payload());
});

// POST /api/settings/storages/:id/cors — разрешить браузеру работать с бакетом с адреса сайта
settingsRouter.post('/storages/:id/cors', async (req, res) => {
  const def = findStorageDef(req.params.id);
  if (!def) throw new HttpError(404, 'Хранилище не найдено');
  const r = await applyCors(def);
  if (!r.ok) throw new HttpError(422, r.error);
  res.json({ ok: true, origin: config.appOrigin });
});

// ---------- сессии и перезапуск ----------

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

// ---------- диагностика загрузки из браузера ----------
// Ошибка «Нет ответа от S3» означает, что браузер не получил ответа от хранилища: его
// блокирует CORS бакета, политика страницы (CSP) или смешанный контент (https → http).
// Сервер проверяет то, что видно ему, и выдаёт ссылку на крошечный тестовый объект —
// браузер пробует загрузить его тем же способом, что и обычные файлы.
const CHECK_KEY_RE = /^\.fm-check-[0-9a-f]{12}$/;

settingsRouter.post('/storages/:id/diagnose', async (req, res) => {
  const def = findStorageDef(req.params.id);
  if (!def) throw new HttpError(404, 'Хранилище не найдено');
  const st = storagesRegistry.get(def.id);
  const checks = [];

  const conn = await testConnection(def);
  checks.push({ id: 'connect', ok: conn.ok, text: conn.ok ? `Сервер подключается к бакету (${conn.latencyMs} мс)` : `Сервер не подключается к бакету: ${conn.error}` });

  const mixed = config.appOrigin.startsWith('https:') && def.endpoint.startsWith('http:');
  checks.push({ id: 'scheme', ok: !mixed, text: mixed
    ? 'Сайт открыт по https, а хранилище — по http: браузер заблокирует обращения (смешанный контент). Укажите endpoint с https://'
    : `Схема адреса подходит (${new URL(def.endpoint).protocol.replace(':', '')})` });

  if (conn.ok) {
    try {
      const rules = await st.getCors();
      const ok = rules.some((r) => (r.AllowedOrigins ?? []).some((o) => o === '*' || o === config.appOrigin)
        && (r.AllowedMethods ?? []).includes('PUT'));
      checks.push({ id: 'cors', ok, text: ok ? `Правила CORS бакета разрешают загрузку с ${config.appOrigin}`
        : `Правила CORS есть, но не разрешают PUT с ${config.appOrigin}` });
    } catch (err) {
      const missing = err.name === 'NoSuchCORSConfiguration' || err.$metadata?.httpStatusCode === 404;
      checks.push({ id: 'cors', ok: missing ? false : null, text: missing
        ? 'У бакета нет правил CORS — большинство хранилищ (в т.ч. Cloud.ru) не пустят браузер; результат — в проверке ниже'
        : `Провайдер не отдаёт правила CORS через API (${err.name}) — смотрите проверку из браузера` });
    }
  }

  let test = null;
  if (conn.ok) {
    const key = `.fm-check-${crypto.randomBytes(6).toString('hex')}`;
    test = { key, ...(await st.presignPut(key, 'text/plain', 2)) };
  }
  res.json({ origin: config.appOrigin, storageClass: def.storageClass || null, checks, test });
});

// POST /api/settings/storages/:id/diagnose/cleanup {key} — удалить тестовый объект
settingsRouter.post('/storages/:id/diagnose/cleanup', async (req, res) => {
  const key = req.body?.key;
  if (typeof key !== 'string' || !CHECK_KEY_RE.test(key)) throw new HttpError(400, 'Некорректный ключ');
  await storagesRegistry.get(req.params.id).deleteObject(key).catch(() => {});
  res.json({ ok: true });
});
