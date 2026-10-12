// Одно S3-хранилище (бакет + папка в нём) поверх AWS SDK v3.
// Через сервер проходят только метаданные — байты файлов идут напрямую между
// браузером и S3 по presigned URL. Все ключи и папки в методах — относительные
// (без префикса хранилища), префикс добавляется здесь.
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
import { config } from './config.js';
import { contentDisposition, isValidFolder, isValidKey, nameFromKey } from './keys.js';

export function createClient(def) {
  return new S3Client({
    endpoint: def.endpoint,
    region: def.region,
    forcePathStyle: def.forcePathStyle,
    credentials: { accessKeyId: def.accessKeyId, secretAccessKey: def.secretAccessKey },
    // Многие S3-совместимые хранилища не поддерживают новые CRC32-чексуммы
    // (включены в SDK по умолчанию с 2025 г.) — шлём их только когда требуется.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
  });
}

/** Проверка доступа к бакету с произвольными (в т.ч. ещё не сохранёнными) параметрами. */
export async function testConnection(def) {
  const c = createClient(def);
  const started = Date.now();
  try {
    await c.send(new HeadBucketCommand({ Bucket: def.bucket }));
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: describeS3Error(err) };
  } finally {
    c.destroy();
  }
}

export function describeS3Error(err) {
  const status = err.$metadata?.httpStatusCode;
  const hint = status === 403 ? 'нет доступа: проверьте ключи и права'
    : status === 404 ? 'бакет не найден' : status === 301 ? 'неверный регион или адресация' : err.message;
  return `${err.name}${status ? ` (HTTP ${status})` : ''}: ${hint}`;
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

// ---------- копирование (для переименования и перемещения) ----------
const MAX_SINGLE_COPY = 5 * 1024 ** 3; // предел CopyObject — 5 ГБ
const COPY_PART_SIZE = 512 * 1024 ** 2;
const COPY_CONCURRENCY = 4;

export class Storage {
  /** @param {{id, name, endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle, prefix, quotaGb, acceptUploads}} def */
  constructor(def) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.bucket = def.bucket;
    this.prefix = def.prefix ?? '';
    this.client = createClient(def);
  }

  destroy() {
    this.client.destroy();
  }

  abs(rel) {
    return this.prefix + rel;
  }

  rel(abs) {
    return abs.slice(this.prefix.length);
  }

  send(command) {
    return this.client.send(command);
  }

  /**
   * Одна страница папки после ключа startAfter (относительного): подпапки и файлы
   * в порядке ключей S3. Для слияния нескольких хранилищ (см. storages.js).
   */
  async listPage(folder, { startAfter, limit = 200 } = {}) {
    const out = await this.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: this.abs(folder),
      Delimiter: '/',
      MaxKeys: limit,
      StartAfter: startAfter ? this.abs(startAfter) : undefined,
    }));
    const folders = (out.CommonPrefixes ?? []).map((p) => this.rel(p.Prefix)).filter(isValidFolder);
    // Маркер самой папки и посторонние объекты (не нашего формата) не показываем.
    const files = (out.Contents ?? [])
      .map((o) => ({ rel: this.rel(o.Key), size: o.Size ?? 0, lastModified: o.LastModified?.toISOString() ?? null }))
      .filter((f) => isValidKey(f.rel));
    return { folders, files, truncated: Boolean(out.IsTruncated) };
  }

  /** Обход всех объектов под относительным префиксом (статистика, рекурсивное удаление). */
  async forEachObject(relPrefix, fn, { max = Infinity } = {}) {
    let cursor;
    let seen = 0;
    do {
      const out = await this.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: this.abs(relPrefix), MaxKeys: 1000, ContinuationToken: cursor,
      }));
      for (const o of out.Contents ?? []) {
        if (seen++ >= max) return false;
        await fn({ rel: this.rel(o.Key), size: o.Size ?? 0, lastModified: o.LastModified?.toISOString() ?? null });
      }
      cursor = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (cursor);
    return true;
  }

  async deleteMany(rels) {
    for (let i = 0; i < rels.length; i += 1000) {
      const out = await this.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: rels.slice(i, i + 1000).map((r) => ({ Key: this.abs(r) })), Quiet: true },
      }));
      if (out.Errors?.length) {
        const e = out.Errors[0];
        throw Object.assign(new Error(`DeleteObjects: ${e.Code} ${e.Message}`), { $fault: 'server' });
      }
    }
  }

  /** Рекурсивное удаление папки пачками по 1000 — без накопления списка ключей в памяти. */
  async deleteFolder(folder) {
    let batch = [];
    let deleted = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.deleteMany(batch);
      deleted += batch.length;
      batch = [];
    };
    await this.forEachObject(folder, async (o) => {
      batch.push(o.rel);
      if (batch.length >= 1000) await flush();
    });
    await flush();
    return deleted;
  }

  putFolderMarker(folder) {
    return this.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.abs(folder), Body: new Uint8Array(0), ContentLength: 0 }));
  }

  headBucket() {
    return this.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  putCors(origin) {
    return this.send(new PutBucketCorsCommand({ Bucket: this.bucket, CORSConfiguration: { CORSRules: corsRules(origin) } }));
  }

  async getCors() {
    return (await this.send(new GetBucketCorsCommand({ Bucket: this.bucket }))).CORSRules ?? [];
  }

  presignPut(rel, contentType) {
    return getSignedUrl(this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: this.abs(rel), ContentType: contentType }),
      { expiresIn: config.limits.uploadUrlTtlSec });
  }

  // По умолчанию — как вложение: HTML/SVG из бакета не исполнится в браузере.
  // Для предпросмотра (inline) сервер обязан передать безопасный contentType из белого списка.
  presignGet(rel, expiresIn, { inline = false, contentType } = {}) {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.abs(rel),
      ResponseContentDisposition: contentDisposition(nameFromKey(rel), inline ? 'inline' : 'attachment'),
      ResponseContentType: contentType,
    }), { expiresIn });
  }

  async headObject(rel) {
    try {
      return await this.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.abs(rel) }));
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  deleteObject(rel) {
    return this.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.abs(rel) }));
  }

  async createMultipart(rel, contentType) {
    const out = await this.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: this.abs(rel), ContentType: contentType }));
    return out.UploadId;
  }

  presignPart(rel, uploadId, partNumber) {
    return getSignedUrl(this.client,
      new UploadPartCommand({ Bucket: this.bucket, Key: this.abs(rel), UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: config.limits.uploadUrlTtlSec });
  }

  // ETag-и частей берём у самого S3 (ListParts), а не у клиента:
  // так не нужно доверять данным из браузера и проще контролировать итоговый размер.
  async listAllParts(rel, uploadId) {
    const parts = [];
    let marker;
    do {
      const out = await this.send(new ListPartsCommand({ Bucket: this.bucket, Key: this.abs(rel), UploadId: uploadId, PartNumberMarker: marker }));
      for (const p of out.Parts ?? []) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size ?? 0 });
      marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (marker);
    return parts.sort((a, b) => a.PartNumber - b.PartNumber);
  }

  completeMultipart(rel, uploadId, parts) {
    return this.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket, Key: this.abs(rel), UploadId: uploadId,
      MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) },
    }));
  }

  abortMultipart(rel, uploadId) {
    return this.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: this.abs(rel), UploadId: uploadId }));
  }

  // CopySource должен быть URL-кодирован (кириллица, пробелы и т.п. в имени).
  copySource(rel) {
    return `${this.bucket}/${this.abs(rel).split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Копирование внутри бакета: байты файла не проходят через VDS. */
  async copyObject(srcRel, dstRel, size, contentType) {
    if (size <= MAX_SINGLE_COPY) {
      await this.send(new CopyObjectCommand({
        Bucket: this.bucket, Key: this.abs(dstRel), CopySource: this.copySource(srcRel), MetadataDirective: 'COPY',
      }));
      return;
    }
    // Больше 5 ГБ — multipart-копирование диапазонами (UploadPartCopy).
    const uploadId = await this.createMultipart(dstRel, contentType);
    try {
      const ranges = [];
      for (let start = 0; start < size; start += COPY_PART_SIZE) ranges.push([start, Math.min(start + COPY_PART_SIZE, size) - 1]);
      const parts = new Array(ranges.length);
      let next = 0;
      const worker = async () => {
        while (next < ranges.length) {
          const i = next++;
          const out = await this.send(new UploadPartCopyCommand({
            Bucket: this.bucket, Key: this.abs(dstRel), UploadId: uploadId, PartNumber: i + 1,
            CopySource: this.copySource(srcRel), CopySourceRange: `bytes=${ranges[i][0]}-${ranges[i][1]}`,
          }));
          parts[i] = { PartNumber: i + 1, ETag: out.CopyPartResult?.ETag };
        }
      };
      await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, ranges.length) }, worker));
      await this.completeMultipart(dstRel, uploadId, parts);
    } catch (err) {
      await this.abortMultipart(dstRel, uploadId).catch(() => {});
      throw err;
    }
  }
}
