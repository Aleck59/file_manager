// Тонкая обёртка над AWS SDK v3. Через сервер проходят только метаданные —
// сами байты файлов идут напрямую между браузером и S3 по presigned URL.
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  CopyObjectCommand,
  UploadPartCopyCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, onConfigChange } from './config.js';
import { contentDisposition, folderToPrefix, isValidFolder, isValidKey, nameFromKey } from './keys.js';

const bucket = () => config.s3.bucket;

export class StorageNotConfigured extends Error {
  constructor() {
    super('Хранилище S3 не настроено. Администратор может указать его в разделе «Настройки».');
    this.status = 503;
    this.code = 'S3_NOT_CONFIGURED';
  }
}

export function createClient(s3cfg) {
  return new S3Client({
    endpoint: s3cfg.endpoint,
    region: s3cfg.region,
    forcePathStyle: s3cfg.forcePathStyle,
    credentials: { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey },
    // Многие S3-совместимые хранилища не поддерживают новые CRC32-чексуммы
    // (включены в SDK по умолчанию с 2025 г.) — шлём их только когда требуется.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
  });
}

// Клиент создаётся лениво и пересоздаётся, когда администратор меняет настройки S3.
let current = null;
export function client() {
  if (!config.s3Configured) throw new StorageNotConfigured();
  current ??= createClient(config.s3);
  return current;
}
onConfigChange((changed) => {
  if (changed.some((k) => k.startsWith('S3_')) && current) {
    current.destroy();
    current = null;
  }
});

/** Проверка доступа к бакету с произвольными (ещё не сохранёнными) параметрами. */
export async function testConnection(s3cfg) {
  const c = createClient(s3cfg);
  const started = Date.now();
  try {
    await c.send(new HeadBucketCommand({ Bucket: s3cfg.bucket }));
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    const hint = status === 403 ? 'нет доступа: проверьте ключи и права'
      : status === 404 ? 'бакет не найден' : status === 301 ? 'неверный регион или адресация' : err.message;
    return { ok: false, latencyMs: Date.now() - started, error: `${err.name}${status ? ` (HTTP ${status})` : ''}: ${hint}` };
  } finally {
    c.destroy();
  }
}

// CORS бакета: браузеру разрешено загружать/скачивать только с нашего домена.
export function corsRules(origin) {
  return [{
    AllowedOrigins: [origin],
    AllowedMethods: ['GET', 'PUT', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600,
  }];
}
export function putBucketCors(origin) {
  return client().send(new PutBucketCorsCommand({ Bucket: bucket(), CORSConfiguration: { CORSRules: corsRules(origin) } }));
}
export async function getBucketCors() {
  return (await client().send(new GetBucketCorsCommand({ Bucket: bucket() }))).CORSRules ?? [];
}

const toFile = (o) => ({
  key: o.Key,
  name: nameFromKey(o.Key),
  size: o.Size ?? 0,
  lastModified: o.LastModified?.toISOString() ?? null,
});

// Содержимое одной папки: подпапки (CommonPrefixes) + файлы (Contents), постранично.
export async function listFolder(folder, { cursor, limit = 200 } = {}) {
  const base = folderToPrefix(folder);
  const out = await client().send(
    new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: base,
      Delimiter: '/',
      MaxKeys: limit,
      ContinuationToken: cursor || undefined,
    }),
  );
  const folders = (out.CommonPrefixes ?? [])
    .map((p) => p.Prefix.slice(config.s3.prefix.length))
    .filter(isValidFolder)
    .map((path) => ({ path, name: path.slice(0, -1).split('/').pop() }))
    // Сортировка «по-русски» (localeCompare) — в браузере: на сервере она подгружает ICU (~5 МБ ОЗУ).
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Маркер самой папки и посторонние объекты (не нашего формата) не показываем.
  const files = (out.Contents ?? []).filter((o) => isValidKey(o.Key)).map(toFile);
  return { folders, files, nextCursor: out.IsTruncated ? out.NextContinuationToken : null };
}

// Обход всех объектов под префиксом (для статистики и рекурсивного удаления).
export async function forEachObject(prefix, fn, { max = Infinity } = {}) {
  let cursor;
  let seen = 0;
  do {
    const out = await client().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, MaxKeys: 1000, ContinuationToken: cursor }),
    );
    for (const o of out.Contents ?? []) {
      if (seen++ >= max) return false;
      await fn(o);
    }
    cursor = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (cursor);
  return true;
}

export async function deleteMany(keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const out = await client().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
    if (out.Errors?.length) {
      const e = out.Errors[0];
      throw Object.assign(new Error(`DeleteObjects: ${e.Code} ${e.Message}`), { $fault: 'server' });
    }
  }
}

export function putFolderMarker(folder) {
  return client().send(new PutObjectCommand({ Bucket: bucket(), Key: folderToPrefix(folder), Body: new Uint8Array(0), ContentLength: 0 }));
}

export function headBucket() {
  return client().send(new HeadBucketCommand({ Bucket: bucket() }));
}

export function presignPut(key, contentType) {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn: config.limits.uploadUrlTtlSec },
  );
}

// По умолчанию — как вложение: HTML/SVG из бакета не исполнится в браузере.
// Для предпросмотра (inline) сервер обязан передать безопасный contentType из белого списка.
export function presignGet(key, expiresIn, { inline = false, contentType } = {}) {
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: contentDisposition(nameFromKey(key), inline ? 'inline' : 'attachment'),
      ResponseContentType: contentType,
    }),
    { expiresIn },
  );
}

export async function headObject(key) {
  try {
    return await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export function deleteObject(key) {
  return client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function createMultipart(key, contentType) {
  const out = await client().send(
    new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
  );
  return out.UploadId;
}

export function presignPart(key, uploadId, partNumber) {
  return getSignedUrl(
    client(),
    new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: config.limits.uploadUrlTtlSec },
  );
}

// ETag-и частей берём у самого S3 (ListParts), а не у клиента:
// так не нужно доверять данным из браузера и проще контролировать итоговый размер.
export async function listAllParts(key, uploadId) {
  const parts = [];
  let marker;
  do {
    const out = await client().send(
      new ListPartsCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker }),
    );
    for (const p of out.Parts ?? []) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size ?? 0 });
    marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
  } while (marker);
  return parts.sort((a, b) => a.PartNumber - b.PartNumber);
}

export function completeMultipart(key, uploadId, parts) {
  return client().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) },
    }),
  );
}

export function abortMultipart(key, uploadId) {
  return client().send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
}

// ---------- копирование (для переименования и перемещения) ----------
// Копирование выполняется внутри S3: байты файла не проходят через VDS.
const MAX_SINGLE_COPY = 5 * 1024 ** 3; // предел CopyObject — 5 ГБ
const COPY_PART_SIZE = 512 * 1024 ** 2;
const COPY_CONCURRENCY = 4;

// CopySource должен быть URL-кодирован (кириллица, пробелы и т.п. в имени).
const copySource = (key) => `${bucket()}/${key.split('/').map(encodeURIComponent).join('/')}`;

export async function copyObject(srcKey, dstKey, size, contentType) {
  if (size <= MAX_SINGLE_COPY) {
    await client().send(new CopyObjectCommand({
      Bucket: bucket(), Key: dstKey, CopySource: copySource(srcKey), MetadataDirective: 'COPY',
    }));
    return;
  }

  // Больше 5 ГБ — multipart-копирование диапазонами (UploadPartCopy).
  const uploadId = await createMultipart(dstKey, contentType);
  try {
    const ranges = [];
    for (let start = 0; start < size; start += COPY_PART_SIZE) {
      ranges.push([start, Math.min(start + COPY_PART_SIZE, size) - 1]);
    }
    const parts = new Array(ranges.length);
    let next = 0;
    const worker = async () => {
      while (next < ranges.length) {
        const i = next++;
        const out = await client().send(new UploadPartCopyCommand({
          Bucket: bucket(), Key: dstKey, UploadId: uploadId, PartNumber: i + 1,
          CopySource: copySource(srcKey), CopySourceRange: `bytes=${ranges[i][0]}-${ranges[i][1]}`,
        }));
        parts[i] = { PartNumber: i + 1, ETag: out.CopyPartResult?.ETag };
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, ranges.length) }, worker));
    await completeMultipart(dstKey, uploadId, parts);
  } catch (err) {
    await abortMultipart(dstKey, uploadId).catch(() => {});
    throw err;
  }
}
