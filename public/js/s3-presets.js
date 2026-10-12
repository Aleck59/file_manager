// Предустановленные S3-совместимые хранилища: при выборе подставляются endpoint, регион,
// способ адресации и класс хранения. Ключи доступа и бакет берутся из консоли провайдера.
// classes — допустимые классы хранения провайдера (заголовок X-Amz-Storage-Class).

// Подписи классов хранения.
export const STORAGE_CLASS_LABELS = {
  '': 'Класс бакета по умолчанию',
  STANDARD: 'STANDARD — стандартный',
  COLD: 'COLD — холодный (дешевле хранение, дороже операции)',
  ICE: 'ICE — ледяной (для редкого доступа)',
  SINGLE: 'SINGLE — однозонный (одна копия, дешевле)',
  STANDARD_IA: 'STANDARD_IA — редкий доступ',
  ONEZONE_IA: 'ONEZONE_IA — редкий доступ, одна зона',
  INTELLIGENT_TIERING: 'INTELLIGENT_TIERING — автоматический',
  GLACIER_IR: 'GLACIER_IR — архив с мгновенным доступом',
};
const GENERIC_CLASSES = ['', 'STANDARD'];
export const S3_PRESETS = [
  {
    id: 'yandex', name: 'Yandex Object Storage',
    endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1', pathStyle: true,
    classes: ['', 'STANDARD', 'COLD', 'ICE'], defaultClass: 'STANDARD',
    hint: 'Ключи: сервисный аккаунт → «Создать статический ключ доступа». Регион всегда ru-central1.',
  },
  {
    id: 'cloudru', name: 'Cloud.ru Object Storage',
    // Path-style выключен: CORS Cloud.ru работает только на адресах <бакет>.s3.cloud.ru.
    endpoint: 'https://s3.cloud.ru', region: 'ru-central-1', pathStyle: false,
    // https://cloud.ru/docs/s3e/ug/topics/concepts__storage-class
    classes: ['STANDARD', 'COLD', 'ICE', 'SINGLE', ''], defaultClass: 'STANDARD',
    hint: 'Access Key ID — в формате <tenant_id>:<key_id>. Класс хранения по умолчанию — STANDARD. Path-style должен быть выключен (иначе Cloud.ru не применит CORS). Если CORS не настроится автоматически, задайте его в консоли: бакет → CORS (Origin — адрес сайта, методы GET, PUT, HEAD, заголовки запроса content-type и x-amz-storage-class — явно: «*» может не работать как «любые»).',
    accessKeyPlaceholder: 'tenant_id:key_id',
  },
  {
    id: 'selectel', name: 'Selectel',
    endpoint: 'https://s3.ru-1.storage.selcloud.ru', region: 'ru-1', pathStyle: true,
    hint: 'Ключи S3 создаются для сервисного пользователя в панели Selectel. Для другого пула замените ru-1 в адресе и регионе.',
  },
  {
    id: 'timeweb', name: 'Timeweb Cloud',
    endpoint: 'https://s3.timeweb.cloud', region: 'ru-1', pathStyle: true,
    hint: 'Ключи доступа показаны на странице хранилища в панели Timeweb Cloud.',
  },
  {
    id: 'vk', name: 'VK Cloud',
    endpoint: 'https://hb.ru-msk.vkcloud-storage.ru', region: 'ru-msk', pathStyle: true,
    hint: 'Ключи: Объектное хранилище → Аккаунты → Добавить аккаунт.',
  },
  {
    id: 'r2', name: 'Cloudflare R2',
    endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com', region: 'auto', pathStyle: true,
    hint: 'Замените <ACCOUNT_ID> на идентификатор аккаунта Cloudflare. Ключи: R2 → Manage API tokens.',
  },
  {
    id: 'aws', name: 'Amazon S3',
    endpoint: 'https://s3.eu-central-1.amazonaws.com', region: 'eu-central-1', pathStyle: false,
    classes: ['', 'STANDARD', 'STANDARD_IA', 'ONEZONE_IA', 'INTELLIGENT_TIERING', 'GLACIER_IR'], defaultClass: '',
    hint: 'Регион в адресе и в поле «Регион» должен совпадать с регионом бакета.',
  },
  {
    id: 'minio', name: 'MinIO (свой сервер)',
    endpoint: 'https://minio.example.com', region: 'us-east-1', pathStyle: true,
    hint: 'Укажите адрес своего MinIO (API-порт, обычно 9000) и ключи пользователя с доступом к бакету.',
  },
];

export function detectPreset(endpoint) {
  if (!endpoint) return null;
  let host;
  try { host = new URL(endpoint).host; } catch { return null; }
  if (host.endsWith('.r2.cloudflarestorage.com')) return S3_PRESETS.find((p) => p.id === 'r2');
  if (host.endsWith('.amazonaws.com')) return S3_PRESETS.find((p) => p.id === 'aws');
  // Шаблоны вроде https://<ACCOUNT_ID>... не являются URL — сравниваем по строке хоста.
  const hostOf = (url) => url.replace(/^https?:\/\//, '').split('/')[0];
  return S3_PRESETS.find((p) => p.id !== 'minio' && hostOf(p.endpoint) === host) ?? null;
}

/** Классы хранения, которые имеет смысл предлагать для данного хранилища. */
export function storageClassesFor(preset, current = '') {
  const list = [...(preset?.classes ?? GENERIC_CLASSES)];
  if (current && !list.includes(current)) list.push(current);
  return list;
}
