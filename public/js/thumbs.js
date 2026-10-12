// Миниатюры изображений в списке и в виде «Плитки».
// Ссылки запрашиваются пачкой (POST /api/files/thumbs — сервер только подписывает их,
// без обращений к S3) и только для элементов, попавших на экран (IntersectionObserver).
// Ссылка живёт 15 минут — кэшируем на 12. Пока картинка грузится и если она не открылась
// (HEIC, повреждённый файл), виден значок типа файла.
import { api } from './api.js';
import { categoryOf, fileBadge, h } from './ui.js';

const TTL_MS = 12 * 60 * 1000;
const BATCH = 100;
const cache = new Map(); // key → { url, until }
const waiting = new Map(); // key → [resolve]
let timer = 0;

async function flush() {
  timer = 0;
  const keys = [...waiting.keys()];
  const resolvers = new Map(waiting);
  waiting.clear();
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH);
    let urls = {};
    try {
      ({ urls } = await api.thumbs(chunk));
    } catch { /* без миниатюр — останутся значки */ }
    for (const key of chunk) {
      const url = urls[key] ?? null;
      cache.set(key, { url, until: Date.now() + TTL_MS });
      for (const resolve of resolvers.get(key)) resolve(url);
    }
  }
}

function thumbUrl(key) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.url);
  return new Promise((resolve) => {
    if (!waiting.has(key)) waiting.set(key, []);
    waiting.get(key).push(resolve);
    if (!timer) timer = setTimeout(flush, 30);
  });
}

/** Ключ переименован/удалён — старая ссылка больше не нужна. */
export function forgetThumb(key) {
  cache.delete(key);
}

const observer = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    entry.target.loadThumb?.();
  }
}, { rootMargin: '200px' }) : null;

/**
 * Контейнер миниатюры: значок типа, поверх которого плавно появляется изображение.
 * @param {{key: string, name: string}} file
 * @param {{ cls?: string, iconSize?: string }} opts
 */
export function thumbnail(file, { cls = 'h-9 w-9 rounded-lg', iconSize = 'h-4 w-4' } = {}) {
  const box = h('span', { class: `thumb relative isolate flex shrink-0 items-center justify-center overflow-hidden ${cls}` },
    fileBadge(file.name, 'h-full w-full', iconSize));
  if (categoryOf(file.name) !== 'image') return box;
  box.loadThumb = async () => {
    const url = await thumbUrl(file.key);
    if (!url || !box.isConnected) return;
    const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false',
      class: 'thumb-img absolute inset-0 h-full w-full object-cover' });
    img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
    box.append(img);
  };
  if (observer) observer.observe(box);
  else box.loadThumb();
  return box;
}
