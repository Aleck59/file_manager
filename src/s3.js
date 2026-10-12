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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';
import { contentDisposition, nameFromKey } from './keys.js';

const { bucket, prefix } = config.s3;

export const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
  // Многие S3-совместимые хранилища не поддерживают новые CRC32-чексуммы
  // (включены в SDK по умолчанию с 2025 г.) — шлём их только когда требуется.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

export async function listFiles({ cursor, limit = 100 } = {}) {
  const out = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: limit,
      ContinuationToken: cursor || undefined,
    }),
  );
  const files = (out.Contents ?? [])
    .filter((o) => !o.Key.endsWith('/'))
    .map((o) => ({
      key: o.Key,
      name: nameFromKey(o.Key),
      size: o.Size ?? 0,
      lastModified: o.LastModified?.toISOString() ?? null,
    }));
  return { files, nextCursor: out.IsTruncated ? out.NextContinuationToken : null };
}

export function presignPut(key, contentType) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: config.limits.uploadUrlTtlSec },
  );
}

export function presignGet(key, expiresIn) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      // Всегда отдаём как вложение: HTML/SVG из бакета не исполнится в браузере.
      ResponseContentDisposition: contentDisposition(nameFromKey(key)),
    }),
    { expiresIn },
  );
}

export async function headObject(key) {
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export function deleteObject(key) {
  return s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function createMultipart(key, contentType) {
  const out = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
  );
  return out.UploadId;
}

export function presignPart(key, uploadId, partNumber) {
  return getSignedUrl(
    s3,
    new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: config.limits.uploadUrlTtlSec },
  );
}

// ETag-и частей берём у самого S3 (ListParts), а не у клиента:
// так не нужно доверять данным из браузера и проще контролировать итоговый размер.
export async function listAllParts(key, uploadId) {
  const parts = [];
  let marker;
  do {
    const out = await s3.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
    );
    for (const p of out.Parts ?? []) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size ?? 0 });
    marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
  } while (marker);
  return parts.sort((a, b) => a.PartNumber - b.PartNumber);
}

export function completeMultipart(key, uploadId, parts) {
  return s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) },
    }),
  );
}

export function abortMultipart(key, uploadId) {
  return s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}
