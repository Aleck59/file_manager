// Правая панель предпросмотра.
// Медиа грузятся напрямую из S3 по короткоживущей inline-ссылке (15 мин), тип которой
// задаёт сервер по белому списку. Текст читается через fetch и выводится как textContent —
// загруженный HTML/JS никогда не исполняется.
import { officeBlock, zipBlock } from './docview.js';
import { api } from './api.js';
import { openGallery } from './gallery.js';
import { openShareDialog } from './share-dialog.js';
import { richView } from './textview.js';
import qrcode from './vendor/qrcode.js';
import {
  $, CATEGORY_STYLE, categoryOf, copyToClipboard, extOf, folderLabel, formatDate, formatSize, h, icon, prefs, toast, toned,
} from './ui.js';

const TEXT_LIMIT = 256 * 1024;
const panel = () => $('#preview');
const backdrop = () => $('#preview-backdrop');
let current = null; // ключ открытого файла — защита от гонок при быстром переключении
let ctx;

export function initPreview(appCtx) {
  ctx = appCtx;
  backdrop().addEventListener('click', closePreview);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current && !document.querySelector('dialog[open]')) closePreview();
  });
  renderEmpty();
}

// Панель показывается только в разделе «Диск».
export function setPreviewEnabled(enabled) {
  panel().classList.toggle('hidden', !enabled);
  panel().classList.toggle('flex', enabled);
  if (!enabled) closePreview();
}

function openDrawer(open) {
  panel().classList.toggle('translate-x-full', !open);
  backdrop().classList.toggle('hidden', !open);
}

export function closePreview() {
  current = null;
  openDrawer(false);
  renderEmpty();
  ctx?.onPreviewClosed?.();
}

function header(title) {
  return h('div', { class: 'flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-800' },
    h('h2', { class: 'text-sm font-semibold' }, title),
    h('button', { type: 'button', class: 'icon-btn xl:hidden', 'aria-label': 'Закрыть предпросмотр', onclick: closePreview }, icon('close')));
}

function renderEmpty() {
  panel().replaceChildren(
    header('Предпросмотр'),
    h('div', { class: 'flex flex-1 flex-col items-center justify-center px-8 text-center' },
      h('span', { class: 'mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800' }, icon('eye', 'h-6 w-6')),
      h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, 'Выберите файл')),
  );
}

function placeholder(name, message) {
  const style = CATEGORY_STYLE[categoryOf(name)];
  return h('div', { class: 'flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 rounded-xl bg-slate-50 dark:bg-slate-800/50' },
    h('span', { class: `flex h-16 w-16 items-center justify-center rounded-2xl ${style.tone}` }, icon(style.icon, 'h-7 w-7')),
    h('span', { class: 'text-xs font-semibold uppercase tracking-wider text-slate-400' }, extOf(name) || 'файл'),
    message && h('p', { class: 'px-6 text-center text-xs text-slate-500 dark:text-slate-400' }, message));
}

async function textBlock(url, size, key, name) {
  const pre = h('pre', { class: 'max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-700 dark:bg-slate-950 dark:text-slate-300' }, 'Загрузка…');
  const wrap = h('div', { class: 'space-y-2' }, pre);
  (async () => {
    try {
      const res = await fetch(url, { headers: size > TEXT_LIMIT ? { Range: `bytes=0-${TEXT_LIMIT - 1}` } : {} });
      if (!res.ok) throw new Error(`S3 ответило ${res.status}`);
      const text = (await res.text()).slice(0, TEXT_LIMIT);
      if (current !== key) return;
      pre.textContent = text || '(пустой файл)';
      if (size > TEXT_LIMIT) wrap.append(h('p', { class: 'text-xs text-slate-500' }, `Показаны первые ${formatSize(TEXT_LIMIT)} из ${formatSize(size)}`));
      // CSV — таблицей, JSON — с отступами, Markdown — оформленным, код — с подсветкой.
      const rich = text && richView(name, text);
      if (!rich) return;
      rich.node.classList.add('tv-box');
      const mode = prefs.get('text-view', 'rich');
      const buttons = [['rich', rich.label], ['raw', 'Текст']].map(([v, label]) => h('button', {
        type: 'button', 'aria-pressed': String(mode === v), onclick: () => setMode(v),
      }, label));
      const switcher = h('div', { class: 'segmented text-xs', role: 'group', 'aria-label': 'Вид текста' }, buttons);
      function setMode(v) {
        prefs.set('text-view', v);
        buttons.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === (v === 'rich'))));
        rich.node.classList.toggle('hidden', v !== 'rich');
        pre.classList.toggle('hidden', v === 'rich');
      }
      wrap.prepend(h('div', { class: 'flex justify-end' }, switcher));
      pre.after(rich.node);
      setMode(mode);
    } catch (err) {
      pre.textContent = `Не удалось загрузить текст: ${err.message}`;
    }
  })();
  return wrap;
}

// ---------- видео и аудио ----------
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
// Варианты качества — файлы рядом с тем же именем и суффиксом «720p», «1080p»…
// («Фильм.mp4», «Фильм.720p.mp4», «Фильм 480p.mp4»). Перекодирования на сервере нет.
const QUALITY_RE = /^(.*?)(?:[ ._-](\d{3,4})p)?\.([^.]+)$/i;
function renditions(file, siblings) {
  const m = QUALITY_RE.exec(file.name);
  if (!m) return [];
  const base = m[1].toLowerCase();
  const list = siblings.filter((f) => categoryOf(f.name) === 'video').map((f) => {
    const x = QUALITY_RE.exec(f.name);
    return x && x[1].toLowerCase() === base ? { file: f, height: x[2] ? Number(x[2]) : 0 } : null;
  }).filter(Boolean);
  return list.length > 1 ? list.sort((a, b) => (b.height || 1e9) - (a.height || 1e9)) : [];
}

function speedSelect(media) {
  const sel = h('select', { class: 'select py-1 text-xs', 'aria-label': 'Скорость' },
    SPEEDS.map((s) => h('option', { value: String(s), selected: s === Number(prefs.get('media-speed', '1')) }, `${s}×`)));
  media.playbackRate = Number(sel.value);
  media.addEventListener('loadedmetadata', () => { media.playbackRate = Number(sel.value); });
  sel.addEventListener('change', () => { media.playbackRate = Number(sel.value); prefs.set('media-speed', sel.value); });
  return sel;
}

function videoPlayer(url, file, siblings) {
  const video = h('video', { src: url, controls: true, preload: 'metadata', playsinline: true, class: 'w-full rounded-xl bg-black' });
  const bar = h('div', { class: 'flex flex-wrap items-center justify-end gap-2 text-xs text-slate-500 dark:text-slate-400' },
    h('label', { class: 'flex items-center gap-1.5' }, 'Скорость', speedSelect(video)));
  const variants = renditions(file, siblings);
  if (variants.length) {
    const sel = h('select', { class: 'select py-1 text-xs', 'aria-label': 'Качество' },
      variants.map((v) => h('option', { value: v.file.key, selected: v.file.key === file.key }, v.height ? `${v.height}p` : 'Исходное')));
    // Смена качества — с того же места, пауза сохраняется.
    sel.addEventListener('change', async () => {
      const at = video.currentTime;
      const paused = video.paused;
      try {
        const { url: next } = await api.preview(sel.value);
        video.src = next;
        video.addEventListener('loadedmetadata', () => {
          video.currentTime = at;
          if (!paused) video.play().catch(() => {});
        }, { once: true });
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    bar.prepend(h('label', { class: 'flex items-center gap-1.5' }, 'Качество', sel));
  }
  return h('div', { class: 'space-y-2' }, video, bar);
}

// Аудио: плейлист из всех аудиофайлов папки, следующий трек включается сам.
function audioPlayer(url, file, siblings) {
  const tracks = siblings.filter((f) => categoryOf(f.name) === 'audio')
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
  if (!tracks.some((t) => t.key === file.key)) tracks.unshift(file);
  let index = tracks.findIndex((t) => t.key === file.key);
  const audio = h('audio', { src: url, controls: true, preload: 'metadata', class: 'w-full' });
  const title = h('p', { class: 'truncate text-sm font-medium' }, file.name);
  const list = h('ol', { class: 'max-h-56 overflow-y-auto rounded-xl border border-slate-200 text-sm dark:border-slate-800' });
  const owner = current;

  async function play(i, autoplay = true) {
    if (i < 0 || i >= tracks.length) return;
    index = i;
    renderList();
    title.textContent = tracks[i].name;
    try {
      const { url: next } = await api.preview(tracks[i].key);
      if (current !== owner) return; // панель уже показывает другой файл
      audio.src = next;
      if (autoplay) audio.play().catch(() => {});
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  function renderList() {
    list.replaceChildren(...tracks.map((t, i) => h('li', {},
      h('button', {
        type: 'button', 'aria-current': i === index ? 'true' : undefined,
        class: `flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60 ${i === index ? 'font-medium text-brand-700 dark:text-brand-300' : ''}`,
        onclick: () => play(i),
      }, h('span', { class: 'w-5 shrink-0 text-right text-xs tabular-nums text-slate-400' }, i === index ? '▶' : String(i + 1)), h('span', { class: 'truncate' }, t.name)))));
  }
  audio.addEventListener('ended', () => play(index + 1));
  renderList();
  const btn = (name, label, fn) => h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onclick: fn }, icon(name));
  return h('div', { class: 'space-y-3' },
    placeholder(file.name),
    audio,
    h('div', { class: 'flex items-center gap-2' },
      btn('chevronLeft', 'Предыдущий трек', () => play(index - 1)),
      btn('chevronRight', 'Следующий трек', () => play(index + 1)),
      h('div', { class: 'min-w-0 flex-1' }, title),
      speedSelect(audio)),
    tracks.length > 1 && list);
}

async function mediaFor(info, file, gallery, siblings = []) {
  const { kind, url } = info;
  if (kind === 'image') {
    const img = h('img', { src: url, alt: file.name, class: 'max-h-[28rem] w-full rounded-xl object-contain checkerboard', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(placeholder(file.name, 'Изображение не удалось отобразить')), { once: true });
    // Щелчок — галерея на весь экран со всеми изображениями папки.
    const open = () => {
      const images = gallery?.() ?? [file];
      openGallery(images, Math.max(0, images.findIndex((f) => f.key === file.key)));
    };
    return h('button', { type: 'button', class: 'group relative block w-full cursor-zoom-in rounded-xl', title: 'Открыть на весь экран', 'aria-label': `Открыть «${file.name}» на весь экран`, onclick: open },
      img,
      h('span', { class: 'absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900/60 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100' }, icon('expand')));
  }
  if (kind === 'video') return videoPlayer(url, file, siblings);
  if (kind === 'audio') return audioPlayer(url, file, siblings);
  if (kind === 'pdf') {
    return h('iframe', { src: url, title: `PDF: ${file.name}`, class: 'h-[28rem] w-full rounded-xl border border-slate-200 bg-white dark:border-slate-800', loading: 'lazy' });
  }
  if (kind === 'text') return textBlock(url, info.size, file.key, file.name);
  if (kind === 'zip') return zipBlock(file);
  if (kind === 'office') return officeBlock(file);
  return placeholder(file.name, 'Предпросмотр для этого типа файлов недоступен');
}

function metaRow(label, value) {
  return h('div', { class: 'flex justify-between gap-4 py-2' },
    h('dt', { class: 'text-slate-500 dark:text-slate-400' }, label),
    h('dd', { class: 'min-w-0 break-words text-right font-medium' }, value));
}

/**
 * @param {{key:string,name:string,size:number,lastModified:string}} file
 * @param {{ folder: string, onDelete?: Function, onRename?: Function, onMove?: Function }} opts
 *   onDelete/onRename/onMove передаются только при наличии прав редактора.
 */
export async function showPreview(file, { folder, onDelete, onRename, onMove, gallery, siblings }) {
  current = file.key;
  openDrawer(true);
  const body = h('div', { class: 'flex-1 space-y-5 overflow-y-auto p-4' },
    h('div', { class: 'aspect-[4/3] w-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800' }));
  panel().replaceChildren(header('Предпросмотр'), body);

  let info;
  try {
    info = await api.preview(file.key);
  } catch (err) {
    if (current !== file.key) return;
    body.replaceChildren(placeholder(file.name, err.message));
    if (err.status === 404) ctx.onPreviewMissing?.(file);
    return;
  }
  if (current !== file.key) return;

  const outline = 'btn-ghost border border-slate-200 dark:border-slate-700';
  const secondary = [
    h('button', { type: 'button', class: outline, onclick: copyLink }, toned('link'), 'Ссылка'),
    h('button', { type: 'button', class: outline, onclick: () => showQr(file) }, toned('qr'), 'QR-код'),
    onRename && h('button', { type: 'button', class: outline, onclick: () => openShareDialog({ file }) }, toned('globe'), 'Поделиться'),
    onRename && h('button', { type: 'button', class: outline, onclick: () => onRename(file) }, toned('pencil'), 'Переименовать'),
    onMove && h('button', { type: 'button', class: outline, onclick: () => onMove(file) }, toned('move'), 'Переместить'),
    onDelete && h('button', { type: 'button', class: `${outline} text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950`, onclick: () => onDelete(file) }, icon('trash'), 'Удалить'),
  ].filter(Boolean);
  // Нечётное число кнопок — последняя растягивается на всю ширину.
  if (secondary.length % 2) secondary.at(-1).classList.add('col-span-2');
  const actions = h('div', { class: 'grid grid-cols-2 gap-2' },
    h('button', { type: 'button', class: 'btn-primary col-span-2', onclick: download }, icon('download'), 'Скачать'),
    ...secondary);

  body.replaceChildren(
    await mediaFor(info, file, gallery, siblings?.() ?? []),
    h('div', {},
      h('h3', { class: 'break-words text-base font-semibold leading-snug' }, file.name),
      h('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400' }, folderLabel(folder))),
    actions,
    h('dl', { class: 'divide-y divide-slate-100 text-sm dark:divide-slate-800' },
      metaRow('Размер', formatSize(info.size)),
      metaRow('Тип', info.contentType),
      metaRow('Изменён', formatDate(info.lastModified)),
      metaRow('Расположение', folderLabel(folder)),
      info.storage && metaRow('Хранилище', info.storage.name)),
  );

  async function download() {
    try {
      const { url } = await api.downloadLink(file.key, 3600);
      window.location.assign(url); // Content-Disposition: attachment — страница не уходит
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  async function copyLink() {
    await copyFileLink(file);
  }
}

export const TTL_LABELS = { 3600: '1 час', 86400: '24 часа', 604800: '7 дней' };

// QR-код ссылки на скачивание — открыть файл на телефоне, наведя камеру.
export async function showQr(file) {
  const ttl = Number(prefs.get('link-ttl', '86400'));
  let url;
  try {
    ({ url } = await api.downloadLink(file.key, ttl));
  } catch (err) {
    return toast(err.message, 'error');
  }
  const qr = qrcode(0, 'L');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 4;
  const scale = Math.max(3, Math.floor(320 / (n + margin * 2)));
  const canvas = h('canvas', { width: (n + margin * 2) * scale, height: (n + margin * 2) * scale, class: 'mx-auto block h-64 w-64 rounded-lg [image-rendering:pixelated]', role: 'img', 'aria-label': `QR-код ссылки на «${file.name}»` });
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#0f172a';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
  const close = h('button', { type: 'button', class: 'btn-primary', onclick: () => dialog.close() }, 'Готово');
  const dialog = h('dialog', { class: 'w-[min(22rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200', 'aria-labelledby': 'qr-title' },
    h('div', { class: 'space-y-4 p-6 text-center' },
      h('h3', { id: 'qr-title', class: 'truncate text-lg font-semibold', title: file.name }, file.name),
      canvas,
      h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, `Наведите камеру телефона. Ссылка действует ${TTL_LABELS[ttl] ?? ''}.`),
      h('div', { class: 'flex justify-center gap-2' },
        h('button', { type: 'button', class: 'btn-ghost', onclick: async () => { await copyToClipboard(url); toast('Ссылка скопирована', 'success'); } }, icon('link'), 'Скопировать'),
        close)));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}

export async function copyFileLink(file) {
  const ttl = Number(prefs.get('link-ttl', '86400'));
  try {
    const { url } = await api.downloadLink(file.key, ttl);
    await copyToClipboard(url);
    toast(`Ссылка скопирована · действует ${TTL_LABELS[ttl] ?? ''}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

export const isPreviewing = (key) => current === key;
