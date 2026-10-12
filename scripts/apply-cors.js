#!/usr/bin/env node
// Применяет CORS-правила ко всем бакетам единого диска (PutBucketCors), разрешая браузеру
// загружать и скачивать файлы только с вашего домена (APP_ORIGIN).
// То же делает кнопка «CORS» у хранилища в Настройки → Хранилища.
// Использование: npm run s3:cors        — применить
//                npm run s3:cors -- --show — показать текущие правила
import { config } from '../src/config.js';
import { Storage } from '../src/s3.js';

if (!config.storages.length) {
  console.error('Хранилища не настроены. Добавьте их в интерфейсе: Настройки → Хранилища.');
  process.exit(1);
}
for (const def of config.storages) {
  const st = new Storage(def);
  try {
    if (process.argv.includes('--show')) {
      console.log(`${def.name} (${def.bucket}):`, JSON.stringify(await st.getCors(), null, 2));
    } else {
      await st.putCors(config.appOrigin);
      console.log(`CORS для «${def.name}» (${def.bucket}) применён. Разрешённый Origin: ${config.appOrigin}`);
    }
  } catch (err) {
    console.error(`${def.name} (${def.bucket}): ошибка ${err.name}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    st.destroy();
  }
}
if (process.exitCode) console.error('Если провайдер не поддерживает PutBucketCors через API — задайте правила из deploy/s3-cors.json в его панели.');
