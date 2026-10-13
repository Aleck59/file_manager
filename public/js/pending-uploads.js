// Незавершённые multipart-загрузки — в localStorage, чтобы продолжить их после
// перезагрузки страницы или закрытия вкладки. Файл браузер не сохраняет: пользователь
// выбирает его заново, а мы сверяем имя, размер и дату изменения.
import { prefs } from './ui.js';

const MAX = 20;
const TTL = 7 * 86_400_000; // хранилище всё равно уберёт брошенные загрузки (lifecycle)
let user = '';

export function initPending(username) { user = username; }
const name = () => `pending-uploads:${user}`;

export function pendingUploads() {
  try {
    const list = JSON.parse(prefs.get(name(), '[]'));
    return Array.isArray(list) ? list.filter((x) => Date.now() - x.startedAt < TTL) : [];
  } catch {
    return [];
  }
}
const write = (list) => prefs.set(name(), JSON.stringify(list.slice(-MAX)));

export function rememberUpload(file, plan, folder) {
  write([...pendingUploads().filter((x) => x.key !== plan.key), {
    key: plan.key, uploadId: plan.uploadId, partSize: plan.partSize, partCount: plan.partCount,
    folder: plan.folder ?? folder, name: file.name, size: file.size, lastModified: file.lastModified, startedAt: Date.now(),
  }]);
}

export function forgetUpload(key) {
  const list = pendingUploads();
  const next = list.filter((x) => x.key !== key);
  if (next.length !== list.length) write(next);
}
