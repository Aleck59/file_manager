// Правая панель предпросмотра.
// Медиа грузятся напрямую из S3 по короткоживущей inline-ссылке (15 мин), тип которой
// задаёт сервер по белому списку. Текст читается через fetch и выводится как textContent —
// загруженный HTML/JS никогда не исполняется.
import { api } from './api.js';
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

async function textBlock(url, size, key) {
  const pre = h('pre', { class: 'max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-700 dark:bg-slate-950 dark:text-slate-300' }, 'Загрузка…');
  (async () => {
    try {
      const res = await fetch(url, { headers: size > TEXT_LIMIT ? { Range: `bytes=0-${TEXT_LIMIT - 1}` } : {} });
      if (!res.ok) throw new Error(`S3 ответило ${res.status}`);
      const text = await res.text();
      if (current !== key) return;
      pre.textContent = text.slice(0, TEXT_LIMIT) || '(пустой файл)';
      if (size > TEXT_LIMIT) pre.after(h('p', { class: 'mt-2 text-xs text-slate-500' }, `Показаны первые ${formatSize(TEXT_LIMIT)} из ${formatSize(size)}`));
    } catch (err) {
      pre.textContent = `Не удалось загрузить текст: ${err.message}`;
    }
  })();
  return pre;
}

async function mediaFor(info, file) {
  const { kind, url } = info;
  if (kind === 'image') {
    const img = h('img', { src: url, alt: file.name, class: 'max-h-[28rem] w-full rounded-xl object-contain checkerboard', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(placeholder(file.name, 'Изображение не удалось отобразить')), { once: true });
    return img;
  }
  if (kind === 'video') return h('video', { src: url, controls: true, preload: 'metadata', playsinline: true, class: 'w-full rounded-xl bg-black' });
  if (kind === 'audio') {
    return h('div', { class: 'space-y-4' }, placeholder(file.name), h('audio', { src: url, controls: true, preload: 'metadata', class: 'w-full' }));
  }
  if (kind === 'pdf') {
    return h('iframe', { src: url, title: `PDF: ${file.name}`, class: 'h-[28rem] w-full rounded-xl border border-slate-200 bg-white dark:border-slate-800', loading: 'lazy' });
  }
  if (kind === 'text') return textBlock(url, info.size, file.key);
  return placeholder(file.name, 'Предпросмотр для этого типа файлов недоступен');
}

function metaRow(label, value) {
  return h('div', { class: 'flex justify-between gap-4 py-2' },
    h('dt', { class: 'text-slate-500 dark:text-slate-400' }, label),
    h('dd', { class: 'min-w-0 break-words text-right font-medium' }, value));
}

/**
 * @param {{key:string,name:string,size:number,lastModified:string}} file
 * @param {{ folder: string, onDelete?: (file) => Promise<void> }} opts
 */
export async function showPreview(file, { folder, onDelete }) {
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

  const actions = h('div', { class: 'grid grid-cols-2 gap-2' },
    h('button', { type: 'button', class: 'btn-primary col-span-2', onclick: download }, icon('download'), 'Скачать'),
    h('button', { type: 'button', class: 'btn-ghost border border-slate-200 dark:border-slate-700', onclick: copyLink }, icon('link'), 'Ссылка'),
    onDelete && h('button', { type: 'button', class: 'btn-ghost border border-slate-200 text-rose-600 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-950', onclick: () => onDelete(file) }, icon('trash'), 'Удалить'));
  if (!onDelete) actions.lastElementChild?.classList.add('col-span-2');

  body.replaceChildren(
    await mediaFor(info, file),
    h('div', {},
      h('h3', { class: 'break-words text-base font-semibold leading-snug' }, file.name),
      h('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400' }, folderLabel(folder))),
    actions,
    h('dl', { class: 'divide-y divide-slate-100 text-sm dark:divide-slate-800' },
      metaRow('Размер', formatSize(info.size)),
      metaRow('Тип', info.contentType),
      metaRow('Изменён', formatDate(info.lastModified)),
      metaRow('Расположение', folderLabel(folder))),
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
