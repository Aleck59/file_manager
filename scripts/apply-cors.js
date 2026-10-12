#!/usr/bin/env node
// Применяет CORS-правила к бакету (PutBucketCors), разрешая браузеру
// загружать и скачивать файлы только с вашего домена (APP_ORIGIN).
// То же самое делает кнопка «Настроить CORS» в Настройки → Хранилище S3.
// Учитываются и .env, и изменения из интерфейса (data/settings.json).
// Использование: npm run s3:cors        — применить
//                npm run s3:cors -- --show — показать текущие правила
import { config } from '../src/config.js';
import { getBucketCors, putBucketCors } from '../src/s3.js';

try {
  if (process.argv.includes('--show')) {
    console.log(JSON.stringify(await getBucketCors(), null, 2));
  } else {
    await putBucketCors(config.appOrigin);
    console.log(`CORS для бакета "${config.s3.bucket}" применён. Разрешённый Origin: ${config.appOrigin}`);
  }
} catch (err) {
  console.error('Ошибка:', err.name, err.message);
  if (!process.argv.includes('--show')) {
    console.error('Если провайдер не поддерживает PutBucketCors через API — задайте правила из deploy/s3-cors.json в его панели.');
  }
  process.exitCode = 1;
}
