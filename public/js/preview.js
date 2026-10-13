// Правая панель предпросмотра.
// Медиа грузятся напрямую из S3 по короткоживущей inline-ссылке (15 мин), тип которой
// задаёт сервер по белому списку. Текст читается через fetch и выводится как textContent —
// загруженный HTML/JS никогда не исполняется.
import { api } from './api.js';
import { openGallery } from './gallery.js';
import { openShareDialog } from './share-dialog.js';
import { richView } from './textview.js';
import qrcode from './vendor/qrcode.js';
import {
  $, CATEGORY_STYLE, categoryOf, copyToClipboard, extOf, folderLabel, formatDate, formatSize, h, icon, prefs, toast,
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
      h('p', { class: 'font-medium' }, 'Файл не выбран'),
      h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' }, 'Выберите файл в списке, чтобы увидеть его содержимое и свойства.')),
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

async function mediaFor(info, file, gallery) {
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
  if (kind === 'video') return h('video', { src: url, controls: true, preload: 'metadata', playsinline: true, class: 'w-full rounded-xl bg-black' });
  if (kind === 'audio') {
    return h('div', { class: 'space-y-4' }, placeholder(file.name), h('audio', { src: url, controls: true, preload: 'metadata', class: 'w-full' }));
  }
  if (kind === 'pdf') {
    return h('iframe', { src: url, title: `PDF: ${file.name}`, class: 'h-[28rem] w-full rounded-xl border border-slate-200 bg-white dark:border-slate-800', loading: 'lazy' });
  }
  if (kind === 'text') return textBlock(url, info.size, file.key, file.name);
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
export async function showPreview(file, { folder, onDelete, onRename, onMove, gallery }) {
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
    h('button', { type: 'button', class: outline, onclick: copyLink }, icon('link'), 'Ссылка'),
    h('button', { type: 'button', class: outline, onclick: () => showQr(file) }, icon('qr'), 'QR-код'),
    onRename && h('button', { type: 'button', class: outline, onclick: () => openShareDialog({ file }) }, icon('globe'), 'Поделиться'),
    onRename && h('button', { type: 'button', class: outline, onclick: () => onRename(file) }, icon('pencil'), 'Переименовать'),
    onMove && h('button', { type: 'button', class: outline, onclick: () => onMove(file) }, icon('move'), 'Переместить'),
    onDelete && h('button', { type: 'button', class: `${outline} text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950`, onclick: () => onDelete(file) }, icon('trash'), 'Удалить'),
  ].filter(Boolean);
  // Нечётное число кнопок — последняя растягивается на всю ширину.
  if (secondary.length % 2) secondary.at(-1).classList.add('col-span-2');
  const actions = h('div', { class: 'grid grid-cols-2 gap-2' },
    h('button', { type: 'button', class: 'btn-primary col-span-2', onclick: download }, icon('download'), 'Скачать'),
    ...secondary);

  body.replaceChildren(
    await mediaFor(info, file, gallery),
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
