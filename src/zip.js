// Чтение ZIP прямо из S3 диапазонами (Range): архив целиком не скачивается.
// Оглавление (central directory) лежит в конце файла — читаем хвост, затем сам каталог.
// Поддерживаются ZIP64, имена в UTF-8 и в CP866 (архивы из Windows с кириллицей).
// Извлечение одного файла — поток: Range-запрос к данным записи → inflateRaw → клиент.
import { Transform } from 'node:stream';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CDH = 0x02014b50;
const LFH = 0x04034b50;
const MAX_CATALOG = 8 * 1024 * 1024; // больше — архив на сотни тысяч файлов, не показываем
export const MAX_ENTRIES = 5000;

const fail = (status, message) => Object.assign(new Error(message), { status });

// CP866: 0x80–0xAF → А–п, 0xE0–0xEF → р–я, 0xF0/0xF1 → Ё/ё; псевдографика — «?».
function cp866(buf) {
  let out = '';
  for (const b of buf) {
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b <= 0xaf) out += String.fromCharCode(0x410 + b - 0x80);
    else if (b >= 0xe0 && b <= 0xef) out += String.fromCharCode(0x440 + b - 0xe0);
    else if (b === 0xf0) out += 'Ё';
    else if (b === 0xf1) out += 'ё';
    else out += '?';
  }
  return out;
}

function dosDate(date, time) {
  if (!date) return null;
  const d = new Date(Date.UTC(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const u64 = (buf, at) => Number(buf.readBigUInt64LE(at));

/** Где лежит каталог: {offset, size, count}. */
async function locateCatalog(st, rel, size) {
  if (size < 22) throw fail(422, 'Это не ZIP-архив');
  const tailLen = Math.min(size, 22 + 65535 + 20);
  const tail = await st.getRange(rel, size - tailLen, size - 1);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { at = i; break; }
  if (at < 0) throw fail(422, 'Это не ZIP-архив или он повреждён');
  let count = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdOffset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = at - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR) throw fail(422, 'Повреждённый ZIP64-архив');
    const z = await st.getRange(rel, u64(tail, loc + 8), u64(tail, loc + 8) + 55);
    if (z.readUInt32LE(0) !== ZIP64_EOCD) throw fail(422, 'Повреждённый ZIP64-архив');
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }
  if (cdOffset + cdSize > size) throw fail(422, 'Повреждённый ZIP-архив');
  return { offset: cdOffset, size: cdSize, count };
}

/**
 * Оглавление архива.
 * @returns {Promise<{entries: {i, name, size, compressed, method, dir, encrypted, modified, offset}[], total: number, truncated: boolean}>}
 */
export async function listZip(st, rel, size) {
  const cat = await locateCatalog(st, rel, size);
  if (cat.size > MAX_CATALOG) throw fail(413, 'Архив слишком большой для просмотра содержимого');
  const buf = cat.size ? await st.getRange(rel, cat.offset, cat.offset + cat.size - 1) : Buffer.alloc(0);
  const entries = [];
  let p = 0;
  let total = 0;
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === CDH) {
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    let compressed = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    let name = flags & 0x800 ? rawName.toString('utf8') : cp866(rawName);
    // Дополнительные поля: ZIP64 (0x0001) — настоящие размеры; Info-ZIP (0x7075) — имя в UTF-8.
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      const body = extra.subarray(e + 4, e + 4 + len);
      if (id === 0x0001) {
        let q = 0;
        if (usize === 0xffffffff && q + 8 <= body.length) { usize = u64(body, q); q += 8; }
        if (compressed === 0xffffffff && q + 8 <= body.length) { compressed = u64(body, q); q += 8; }
        if (offset === 0xffffffff && q + 8 <= body.length) { offset = u64(body, q); q += 8; }
      } else if (id === 0x7075 && body.length > 5 && body[0] === 1) {
        name = body.subarray(5).toString('utf8');
      }
      e += 4 + len;
    }
    if (total < MAX_ENTRIES) {
      entries.push({
        i: total, name: name.replaceAll('\\', '/'), size: usize, compressed, method,
        dir: name.endsWith('/') || name.endsWith('\\'), encrypted: Boolean(flags & 1), modified: dosDate(date, time), offset,
      });
    }
    total += 1;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, total, truncated: total > entries.length };
}

/** Начало данных записи: локальный заголовок может отличаться длиной extra от каталога. */
async function dataStart(st, rel, entry) {
  const head = await st.getRange(rel, entry.offset, entry.offset + 29);
  if (head.readUInt32LE(0) !== LFH) throw fail(422, 'Повреждённый ZIP-архив');
  return entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
}

function checkExtractable(entry) {
  if (entry.dir) throw fail(400, 'Это папка внутри архива');
  if (entry.encrypted) throw fail(422, 'Файл в архиве защищён паролем');
  if (entry.method !== 0 && entry.method !== 8) throw fail(422, 'Неподдерживаемый способ сжатия (поддерживаются Store и Deflate)');
}

/** Ограничитель: не больше заявленного размера (защита от «ZIP-бомб» с ложным размером). */
function capped(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) return cb(fail(422, 'Размер файла в архиве не совпадает с заявленным'));
      cb(null, chunk);
    },
  });
}

/** Поток распакованного файла из архива. */
export async function entryStream(st, rel, entry) {
  checkExtractable(entry);
  const start = await dataStart(st, rel, entry);
  if (entry.compressed === 0) return { stream: null };
  const raw = await st.getRangeStream(rel, start, start + entry.compressed - 1);
  const out = capped(entry.size);
  const fwd = (err) => out.destroy(err);
  raw.on('error', fwd);
  if (entry.method === 0) return { stream: raw.pipe(out) };
  const inflate = zlib.createInflateRaw();
  inflate.on('error', fwd);
  return { stream: raw.pipe(inflate).pipe(out) };
}

/** Небольшой файл из архива целиком в память (XML документа Office). */
export async function entryBuffer(st, rel, entry, maxSize) {
  checkExtractable(entry);
  if (entry.size > maxSize || entry.compressed > maxSize) throw fail(413, 'Документ слишком большой для просмотра');
  if (entry.compressed === 0) return Buffer.alloc(0);
  const start = await dataStart(st, rel, entry);
  const raw = await st.getRange(rel, start, start + entry.compressed - 1);
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: maxSize });
}
