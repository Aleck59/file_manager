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
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { contentDisposition, isValidFolder, isValidKey, nameFromKey } from './keys.js';

// Совместимость с S3-совместимыми хранилищами. AWS SDK v3 (с 2025 г.) для операций, которым
// нужна контрольная сумма тела (PutBucketCors, DeleteObjects), шлёт новый x-amz-checksum-crc32
// вместо классического Content-MD5. Многие провайдеры принимают только Content-MD5 и отвечают
// ошибкой — тогда, например, не настраивается CORS бакета и браузер не может загружать файлы.
// Для таких запросов считаем Content-MD5 сами и убираем CRC32-заголовки (до подписи запроса).
const NEEDS_MD5 = new Set(['cors', 'delete', 'lifecycle', 'tagging']);
function contentMd5Middleware(next) {
  return async (args) => {
    const req = args.request;
    const body = req?.body;
    if (req?.query && Object.keys(req.query).some((k) => NEEDS_MD5.has(k)) && (typeof body === 'string' || body instanceof Uint8Array)) {
      for (const h of Object.keys(req.headers)) {
        if (/^x-amz-(checksum-|sdk-checksum-algorithm)/i.test(h)) delete req.headers[h];
      }
      req.headers['content-md5'] = crypto.createHash('md5').update(body).digest('base64');
    }
    return next(args);
  };
}

export function createClient(def) {
  const client = new S3Client({
    endpoint: def.endpoint,
    region: def.region,
    forcePathStyle: def.forcePathStyle,
    credentials: { accessKeyId: def.accessKeyId, secretAccessKey: def.secretAccessKey },
    // Многие S3-совместимые хранилища не поддерживают новые CRC32-чексуммы
    // (включены в SDK по умолчанию с 2025 г.) — шлём их только когда требуется.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
    // Без таймаутов «молчащее» хранилище (пакеты теряются) подвешивало запросы на минуты,
    // а вместе с ними — список файлов единого диска для всех пользователей.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 },
  });
  // Сразу перед подписью: после контрольных сумм (шаг build), и Content-MD5 входит в подпись.
  client.middlewareStack.addRelativeTo(contentMd5Middleware, { relation: 'before', toMiddleware: 'httpSigningMiddleware', name: 'contentMd5Compat' });
  return client;
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
    // Только явные имена — ровно то, что шлёт браузер. «*» не все хранилища понимают как
    // «любой заголовок», а Cloud.ru с «*» в списке отклоняет запрос даже при явных именах.
    AllowedHeaders: ['content-type', 'x-amz-storage-class'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600,
  }];
}

// node:https через require: ESM-импорт node:http подтягивает undici (лишняя память).
const httpsLib = createRequire(import.meta.url)('node:https');
const httpLib = createRequire(import.meta.url)('node:http');

/**
 * Предварительный запрос CORS (OPTIONS) — такой же, какой браузер шлёт перед PUT.
 * Позволяет с сервера увидеть, почему хранилище не пускает браузер.
 * @returns {Promise<{status:number, allowOrigin:string|null, code:string|null, message:string|null}>}
 */
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (str) => str?.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : XML_ENTITIES[e.toLowerCase()])) ?? null;

export function probePreflight(url, origin, requestHeaders = []) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? httpsLib : httpLib;
    const headers = { Origin: origin, 'Access-Control-Request-Method': 'PUT' };
    if (requestHeaders.length) headers['Access-Control-Request-Headers'] = requestHeaders.join(',');
    const req = lib.request(u, { method: 'OPTIONS', headers, timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        allowOrigin: res.headers['access-control-allow-origin'] ?? null,
        code: body.match(/<Code>([^<]{1,100})<\/Code>/)?.[1] ?? null,
        message: decodeXml(body.match(/<Message>([^<]{1,300})<\/Message>/)?.[1] ?? null),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('таймаут')));
    req.on('error', (err) => resolve({ status: 0, allowOrigin: null, code: null, message: err.message }));
    req.end();
  });
}

// Предварительный запрос CORS с сервера — как его отправит браузер. Если хранилище отказывает,
// пробуем варианты (без заголовков, другой стиль адреса), чтобы назвать точную причину.
export async function preflightCheck(def, test, origin) {
  const names = Object.keys(test.headers).map((k) => k.toLowerCase());
  const allowed = (r) => r.status >= 200 && r.status < 300 && (r.allowOrigin === origin || r.allowOrigin === '*');
  const main = await probePreflight(test.url, origin, names);
  if (allowed(main)) return { id: 'preflight', ok: true, text: 'Хранилище разрешает браузеру загрузку (проверка CORS с сервера)' };
  const why = main.status ? `HTTP ${main.status}${main.code ? ` ${main.code}` : ''}${main.message ? `: ${main.message}` : ''}` : main.message;

  const u = new URL(test.url);
  if (def.forcePathStyle && !def.bucket.includes('.')) {
    const alt = new URL(test.url);
    alt.hostname = `${def.bucket}.${u.hostname}`;
    alt.pathname = u.pathname.replace(`/${def.bucket}`, '') || '/';
    if (allowed(await probePreflight(alt.href, origin, names))) {
      return { id: 'preflight', ok: false, text: `Хранилище применяет CORS только к адресам вида ${def.bucket}.${u.host} — выключите «Path-style» в параметрах хранилища (${why})` };
    }
  }
  // Без дополнительных заголовков: если и так отказ — не совпадает источник или метод.
  if (!allowed(await probePreflight(test.url, origin, []))) {
    return { id: 'preflight', ok: false, text: `Хранилище не разрешает PUT с ${origin}: в правиле CORS «Источник» (AllowedOrigin) должен в точности совпадать с этим адресом (схема, домен, без «/» на конце), метод — PUT (${why})` };
  }
  // Источник и метод подходят — значит, не разрешены заголовки. Проверяем каждый отдельно.
  const denied = [];
  for (const h of names) if (!allowed(await probePreflight(test.url, origin, [h]))) denied.push(h);
  const list = (denied.length ? denied : names).join(', ');
  return { id: 'preflight', ok: false, headers: denied.length ? denied : names,
    text: `Правила CORS не разрешают заголовки запроса: ${list}. Впишите их явно в «Заголовки запроса» (AllowedHeader) и уберите оттуда «*» (Cloud.ru с ним отклоняет запрос) — или нажмите «Исправить правила CORS»` };
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
    // Класс хранения новых объектов; undefined — класс бакета по умолчанию.
    this.storageClass = def.storageClass || undefined;
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

  async send(command) {
    try {
      return await this.client.send(command);
    } finally {
      this.clockKnown = true;
      this.warnClockSkew();
    }
  }

  // ---------- часы ----------
  // Presigned-ссылка содержит время создания (X-Amz-Date). Если часы VDS расходятся
  // с хранилищем больше чем на ~15 минут, S3 отвергает ссылку («The difference between
  // the request time and the current time is too large»), хотя запросы сервера проходят:
  // SDK сам учитывает расхождение (systemClockOffset — по заголовку Date каждого ответа),
  // но только для своих запросов, не для ссылок. Подписываем ссылки по часам хранилища.
  get clockOffsetMs() {
    return this.client.config.systemClockOffset || 0;
  }

  warnClockSkew() {
    const sec = Math.round(this.clockOffsetMs / 1000);
    if (Math.abs(sec) < 60 || this.clockWarned) return;
    this.clockWarned = true;
    console.warn(`[s3] Часы сервера расходятся с хранилищем «${this.name}» на ${sec} с — ссылки подписываются `
      + 'по времени хранилища; настройте синхронизацию времени (timedatectl set-ntp true)');
  }

  async signingDate() {
    // Расхождение ещё не измерено (не было ни одного ответа) — один лёгкий запрос.
    if (!this.clockKnown) await this.headBucket().catch(() => {});
    return new Date(Date.now() + this.clockOffsetMs);
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

  /** Обход ВСЕХ объектов бакета, не только папки хранилища (для реального занятого объёма). */
  async forEachBucketObject(fn, { max = Infinity } = {}) {
    let cursor;
    let seen = 0;
    do {
      const out = await this.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1000, ContinuationToken: cursor }));
      for (const o of out.Contents ?? []) {
        if (seen++ >= max) return false;
        await fn(o.Key, o.Size ?? 0, o.LastModified?.toISOString() ?? null);
      }
      cursor = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (cursor);
    return true;
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

  // Размер входит в подпись (заголовок Content-Length): S3 отклонит загрузку
  // любого другого объёма, поэтому лимит размера нельзя обойти, загрузив по ссылке
  // больше заявленного и не вызвав /uploads/complete.
  // Возвращает { url, headers }: заголовки браузер обязан отправить вместе с PUT.
  // Класс хранения подписывается как заголовок, а не параметр ссылки: параметр
  // x-amz-storage-class в адресе понимают не все S3-совместимые хранилища (SignatureDoesNotMatch).
  async presignPut(rel, contentType, size) {
    const url = await getSignedUrl(this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: this.abs(rel), ContentType: contentType, ContentLength: size, StorageClass: this.storageClass }),
      { expiresIn: config.limits.uploadUrlTtlSec, signableHeaders: new Set(['content-length']),
        unhoistableHeaders: new Set(['x-amz-storage-class']), signingDate: await this.signingDate() });
    const headers = { 'Content-Type': contentType };
    if (this.storageClass) headers['X-Amz-Storage-Class'] = this.storageClass;
    return { url, headers };
  }

  // По умолчанию — как вложение: HTML/SVG из бакета не исполнится в браузере.
  // Для предпросмотра (inline) сервер обязан передать безопасный contentType из белого списка.
  async presignGet(rel, expiresIn, { inline = false, contentType } = {}) {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.abs(rel),
      ResponseContentDisposition: contentDisposition(nameFromKey(rel), inline ? 'inline' : 'attachment'),
      ResponseContentType: contentType,
    }), { expiresIn, signingDate: await this.signingDate() });
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

  async createMultipart(rel, contentType, storageClass = this.storageClass) {
    const out = await this.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: this.abs(rel), ContentType: contentType, StorageClass: storageClass }));
    return out.UploadId;
  }

  async presignPart(rel, uploadId, partNumber) {
    return getSignedUrl(this.client,
      new UploadPartCommand({ Bucket: this.bucket, Key: this.abs(rel), UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: config.limits.uploadUrlTtlSec, signingDate: await this.signingDate() });
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
  // Класс хранения при копировании нужно указать явно — иначе S3 запишет копию в классе
  // по умолчанию, и переименование «холодного» файла сделало бы его «стандартным» (и наоборот).
  async copyObject(srcRel, dstRel, size, contentType, storageClass = this.storageClass) {
    if (size <= MAX_SINGLE_COPY) {
      await this.send(new CopyObjectCommand({
        Bucket: this.bucket, Key: this.abs(dstRel), CopySource: this.copySource(srcRel), MetadataDirective: 'COPY',
        StorageClass: storageClass,
      }));
      return;
    }
    // Больше 5 ГБ — multipart-копирование диапазонами (UploadPartCopy).
    const uploadId = await this.createMultipart(dstRel, contentType, storageClass);
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
