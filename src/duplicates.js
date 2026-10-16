// Поиск дубликатов: одинаковый размер и одинаковый хеш содержимого (ETag из S3).
// Файлы не скачиваются: S3 отдаёт ETag в списке объектов. У обычной загрузки ETag — MD5
// содержимого; у составной (multipart) — хеш частей, поэтому одинаковые файлы, загруженные
// разными способами, могут не совпасть (лишнего не найдём, но и ложных совпадений не будет).
//
// Память: сначала считаем, сколько файлов каждого размера, затем держим в памяти только
// файлы с неуникальным размером. Результат кешируется на 10 минут.
import { formatRef, isReservedFolder, isValidKey } from './keys.js';
import * as storages from './storages.js';

const TTL = 10 * 60_000;
const MAX_GROUPS = 1000;
let cache = null; // {at, groups, warnings}
let running = null;

async function scan() {
  const sizes = new Map();
  const ok = (rel, size) => size > 0 && isValidKey(rel) && !isReservedFolder(rel);
  const first = await storages.everywhere((st) => st.forEachObject('', (o) => {
    if (ok(o.rel, o.size)) sizes.set(o.size, (sizes.get(o.size) ?? 0) + 1);
  }));
  for (const [size, n] of sizes) if (n < 2) sizes.delete(size);
  const byHash = new Map();
  const second = await storages.everywhere((st) => st.forEachObject('', (o) => {
    if (!ok(o.rel, o.size) || !sizes.has(o.size) || !o.etag) return;
    const id = `${o.size}:${o.etag}`;
    let list = byHash.get(id);
    if (!list) byHash.set(id, list = []);
    list.push({ key: formatRef(st.id, o.rel), rel: o.rel, size: o.size, lastModified: o.lastModified });
  }));
  const groups = [...byHash.values()].filter((g) => g.length > 1)
    .sort((a, b) => (b.length - 1) * b[0].size - (a.length - 1) * a[0].size)
    .slice(0, MAX_GROUPS);
  return { at: Date.now(), groups, warnings: [...first.warnings, ...second.warnings] };
}

/** @returns {Promise<{at: number, groups: Array<Array<{key, rel, size, lastModified}>>, warnings: Array}>} */
export async function find({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < TTL) return cache;
  running ??= scan().then((r) => { cache = r; return r; }).finally(() => { running = null; });
  return running;
}

export function invalidate() { cache = null; }
