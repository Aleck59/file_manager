#!/usr/bin/env node
// Применяет CORS-правила к бакету (PutBucketCors), разрешая браузеру
// загружать и скачивать файлы только с вашего домена (APP_ORIGIN).
// Использование: npm run s3:cors        — применить
//                npm run s3:cors -- --show — показать текущие правила
import { GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { config } from '../src/config.js';
import { s3 } from '../src/s3.js';

const Bucket = config.s3.bucket;

if (process.argv.includes('--show')) {
  try {
    const out = await s3.send(new GetBucketCorsCommand({ Bucket }));
    console.log(JSON.stringify(out.CORSRules, null, 2));
  } catch (err) {
    console.error('Не удалось получить CORS:', err.name, err.message);
    process.exitCode = 1;
  }
} else {
  const rules = [
    {
      AllowedOrigins: [config.appOrigin],
      AllowedMethods: ['GET', 'PUT', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    },
  ];
  try {
    await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }));
    console.log(`CORS для бакета "${Bucket}" применён. Разрешённый Origin: ${config.appOrigin}`);
  } catch (err) {
    console.error('Не удалось применить CORS:', err.name, err.message);
    console.error('Если провайдер не поддерживает PutBucketCors через API — задайте правила из deploy/s3-cors.json в его панели.');
    process.exitCode = 1;
  }
}
