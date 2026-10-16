// Потоковая сборка ZIP: файлы из S3 идут в ответ по очереди, без сжатия (STORE) и без
// буфера в памяти — на сервере держится только оглавление (имена и смещения).
// Файлы и архивы больше 4 ГБ — в формате ZIP64. Контрольная сумма считается на лету.
import zlib from 'node:zlib';

const MAX32 = 0xffffffff;
const FLAGS = 0x0808; // бит 3: размеры и CRC после данных; бит 11: имена в UTF-8

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param {import('node:stream').Writable} out — куда писать (ответ HTTP)
 * @param {AsyncIterable<{name: string, size: number, mtime?: Date, open: () => Promise<AsyncIterable<Buffer>>}>} entries
 * @param {{ isAborted?: () => boolean }} [opts]
 * @returns {Promise<{count: number, bytes: number}>}
 */
export async function writeZip(out, entries, { isAborted = () => false } = {}) {
  let offset = 0;
  const central = [];

  const write = (buf) => new Promise((resolve, reject) => {
    if (isAborted()) return reject(Object.assign(new Error('Скачивание прервано'), { aborted: true }));
    offset += buf.length;
    if (out.write(buf)) return resolve();
    const done = (err) => { out.off('drain', ok); out.off('close', closed); err ? reject(err) : resolve(); };
    const ok = () => done();
    const closed = () => done(Object.assign(new Error('Скачивание прервано'), { aborted: true }));
    out.once('drain', ok);
    out.once('close', closed);
  });

  for await (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const start = offset;
    const zip64 = entry.size >= MAX32 || start >= MAX32;
    const { time, date } = dosDateTime(entry.mtime);

    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2); } // размеры — в дескрипторе
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    local.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    await write(Buffer.concat([local, name, extra]));

    let crc = 0;
    let size = 0;
    for await (const chunk of await entry.open()) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      if (!zip64 && size >= MAX32) throw new Error(`Файл «${entry.name}» изменился во время скачивания`);
      await write(chunk);
    }

    const desc = Buffer.alloc(zip64 ? 24 : 16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    if (zip64) { desc.writeBigUInt64LE(BigInt(size), 8); desc.writeBigUInt64LE(BigInt(size), 16); }
    else { desc.writeUInt32LE(size, 8); desc.writeUInt32LE(size, 12); }
    await write(desc);
    central.push({ name, crc: crc >>> 0, size, start, zip64, time, date });
  }

  // Оглавление
  const cdStart = offset;
  for (const e of central) {
    const extra = e.zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (e.zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(e.size), 4);
      extra.writeBigUInt64LE(BigInt(e.size), 12);
      extra.writeBigUInt64LE(BigInt(e.start), 20);
    }
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(45, 4);
    head.writeUInt16LE(e.zip64 ? 45 : 20, 6);
    head.writeUInt16LE(FLAGS, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(e.time, 12);
    head.writeUInt16LE(e.date, 14);
    head.writeUInt32LE(e.crc, 16);
    head.writeUInt32LE(e.zip64 ? MAX32 : e.size, 20);
    head.writeUInt32LE(e.zip64 ? MAX32 : e.size, 24);
    head.writeUInt16LE(e.name.length, 28);
    head.writeUInt16LE(extra.length, 30);
    // комментарий, диск, атрибуты — нули
    head.writeUInt32LE(e.zip64 ? MAX32 : e.start, 42);
    await write(Buffer.concat([head, e.name, extra]));
  }
  const cdSize = offset - cdStart;

  const need64 = central.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32 || central.some((e) => e.zip64);
  if (need64) {
    const z64Start = offset;
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(central.length), 24);
    rec.writeBigUInt64LE(BigInt(central.length), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(z64Start), 8);
    loc.writeUInt32LE(1, 16);
    await write(Buffer.concat([rec, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(need64 ? 0xffff : central.length, 8);
  end.writeUInt16LE(need64 ? 0xffff : central.length, 10);
  end.writeUInt32LE(need64 ? MAX32 : cdSize, 12);
  end.writeUInt32LE(need64 ? MAX32 : cdStart, 16);
  await write(end);
  return { count: central.length, bytes: offset };
}
