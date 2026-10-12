// Предустановленные S3-совместимые хранилища: при выборе подставляются endpoint, регион
// и способ адресации. Ключи доступа и бакет берутся из консоли провайдера.
export const S3_PRESETS = [
  {
    id: 'yandex', name: 'Yandex Object Storage',
    endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1', pathStyle: true,
    hint: 'Ключи: сервисный аккаунт → «Создать статический ключ доступа». Регион всегда ru-central1.',
  },
  {
    id: 'cloudru', name: 'Cloud.ru Object Storage',
    endpoint: 'https://s3.cloud.ru', region: 'ru-central-1', pathStyle: true,
    hint: 'Access Key ID указывается в формате <tenant_id>:<key_id> — см. раздел документации Cloud.ru о подключении к Object Storage через AWS CLI/SDK.',
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
