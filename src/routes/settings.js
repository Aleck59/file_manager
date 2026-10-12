// Сведения о хранилище и проверка подключения (только для администратора).
// Секреты (ключи доступа) наружу не отдаются никогда.
import { Router } from 'express';
import { config } from '../config.js';
import * as storage from '../s3.js';

export const settingsRouter = Router();

settingsRouter.get('/storage', (req, res) => {
  const { endpoint, region, bucket, prefix, forcePathStyle } = config.s3;
  const { maxFileSize, multipartThreshold, partSize, uploadUrlTtlSec } = config.limits;
  res.json({
    storage: { endpoint, region, bucket, prefix, forcePathStyle },
    limits: { maxFileSize, multipartThreshold, partSize, uploadUrlTtlSec },
    session: { ttlHours: config.auth.sessionTtlSec / 3600 },
  });
});

settingsRouter.post('/storage/check', async (req, res) => {
  const started = Date.now();
  try {
    await storage.headBucket();
    res.json({ ok: true, latencyMs: Date.now() - started });
  } catch (err) {
    console.error('Проверка S3 не прошла:', err.name, err.message);
    res.json({ ok: false, latencyMs: Date.now() - started, error: `${err.name}${err.$metadata?.httpStatusCode ? ` (HTTP ${err.$metadata.httpStatusCode})` : ''}` });
  }
});
