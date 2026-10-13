// Перенос файла в другое хранилище единого диска. S3 не умеет копировать между разными
// бакетами/провайдерами, поэтому байты идут через сервер: объект читается потоком из
// исходного бакета и частями по 5 МБ пишется в целевой (память — одна часть, но трафик
// VDS — весь размер файла). Ключ (папка, имя, id) сохраняется; исходный объект удаляется
// только после того, как новый записан и его размер совпал.
import { activeJobs, createJob, finishJob, streamInto } from './url-import.js';
import * as storages from './storages.js';

const MAX_ACTIVE = 2;

export async function startTransfer({ key, storageId, user, onDone }) {
  const { st, rel } = storages.resolveRef(key);
  const target = storages.get(storageId);
  if (!target) throw Object.assign(new Error('Хранилище не найдено'), { status: 404 });
  if (target.id === st.id) throw Object.assign(new Error('Файл уже в этом хранилище'), { status: 400 });
  if (activeJobs().length >= MAX_ACTIVE) throw Object.assign(new Error('Сервер уже переносит файлы — повторите через минуту'), { status: 429 });
  const head = await st.headObject(rel);
  if (!head) throw Object.assign(new Error('Файл не найден'), { status: 404 });
  const size = head.ContentLength ?? 0;
  if (target.def.quotaGb > 0) {
    const stats = await storages.getStats();
    const used = stats.storages.find((x) => x.id === target.id)?.bucketSize ?? 0;
    if (used + size > target.def.quotaGb * 1024 ** 3) {
      throw Object.assign(new Error(`В хранилище «${target.name}» не хватает места (квота)`), { status: 507 });
    }
  }
  const job = createJob({ type: 'transfer', user, name: rel.split('~').slice(1).join('~'), folder: rel.slice(0, rel.lastIndexOf('/') + 1), size, target: target.name });
  run(job, st, target, rel, head).then(() => onDone?.(job), () => onDone?.(job));
  return { id: job.id, type: job.type, name: job.name, size, status: job.status, target: target.name };
}

async function run(job, st, target, rel, head) {
  let uploadId = null;
  let verified = false;
  try {
    const { body } = await st.getStream(rel);
    job.controller.signal.addEventListener('abort', () => body.destroy?.(), { once: true });
    await streamInto(target, rel, head.ContentType, body, job, (n) => { uploadId = n; });
    uploadId = null;
    const check = await target.headObject(rel);
    if ((check?.ContentLength ?? -1) !== job.size) throw new Error('Размер в новом хранилище не совпал — исходный файл оставлен');
    verified = true;
    try {
      await st.deleteObject(rel);
    } catch {
      throw new Error(`Файл скопирован в «${target.name}», но исходный удалить не удалось — удалите его вручную`);
    }
    storages.invalidateStats();
    job.file = storages.fileInfo(target, rel, job.size, head.LastModified);
    job.status = 'done';
  } catch (err) {
    if (uploadId) await target.abortMultipart(rel, uploadId).catch(() => {});
    const aborted = job.controller.signal.aborted;
    // Недописанная или непроверенная копия не нужна (исходный файл на месте).
    // Проверенную не трогаем: даже если удаление исходного «упало», файл не потеряется.
    if (!verified) await target.deleteObject(rel).catch(() => {});
    job.status = aborted ? 'cancelled' : 'error';
    job.error = aborted ? 'Отменено' : (err.message || 'Ошибка переноса');
  } finally {
    finishJob(job);
  }
}
