// Страница публичной ссылки /s/<id>: скачать файл, открыть папку или загрузить файлы
// владельцу («загрузить мне»). Работает без входа; пароль ссылки — через /unlock.
import { ProgressView } from './progress.js';
import { UploadCancelled, uploadFile } from './uploader.js';
import { $, extOf, fileBadge, formatDate, formatSize, h, icon, toast } from './ui.js';

// /s/<id> или короткий адрес портала /<адрес>
const segs = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
const id = (segs[0] === 's' ? segs[1] : segs[0]) ?? '';
const box = $('#share');
const foot = $('#share-foot');

class CallError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function call(method, path, body) {
  const res = await fetch(`/api/public/s/${encodeURIComponent(id)}${path}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new CallError(data.message ?? data.error ?? `Ошибка ${res.status}`, res.status);
  return data;
}

fetch('/api/branding').then((r) => r.json()).then((b) => {
  if (b.name) { $('#brand-name').textContent = b.name; document.title = b.name; }
  if (b.logo) $('#brand-logo').src = b.logo;
}).catch(() => {});

function message(iconName, title, text, tone = 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400') {
  box.replaceChildren(h('div', { class: 'py-6 text-center' },
    h('span', { class: `mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl ${tone}` }, icon(iconName, 'h-6 w-6')),
    h('p', { class: 'text-lg font-semibold' }, title),
    text && h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' }, text)));
}

function footer(info) {
  const parts = [];
  if (info.type === 'upload') {
    if (info.owner) parts.push(`Файлы получит ${info.owner}`);
    if (info.expiresAt) parts.push(`до ${formatDate(info.expiresAt)}`);
    foot.textContent = parts.join(' · ');
    return;
  }
  if (info.owner) parts.push(`Поделился: ${info.owner}`);
  parts.push(info.expiresAt ? `Ссылка действует до ${formatDate(info.expiresAt)}` : 'Ссылка бессрочная');
  foot.textContent = parts.join(' · ');
}

async function start() {
  let info;
  try {
    info = await call('GET', '');
  } catch (err) {
    return message('alert', err.status === 404 ? 'Ссылка не найдена' : 'Ссылка недоступна', err.message,
      'bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400');
  }
  footer(info);
  if (info.needsPassword && !info.unlocked) return passwordForm();
  if (info.type === 'file') return fileView(info);
  if (info.type === 'folder') return folderView(info);
  return uploadView(info);
}

// ---------- пароль ----------
function passwordForm() {
  const input = h('input', { id: 'share-password', type: 'password', class: 'input', autocomplete: 'off', required: true });
  const error = h('p', { class: 'hidden rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn-primary w-full py-2.5' }, 'Открыть');
  const form = h('form', { class: 'space-y-4' },
    h('div', { class: 'text-center' },
      h('span', { class: 'mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400' }, icon('key', 'h-5 w-5')),
      h('p', { class: 'font-semibold' }, 'Ссылка защищена паролем'),
      h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' }, 'Пароль сообщил тот, кто поделился ссылкой.')),
    h('div', {}, h('label', { for: 'share-password', class: 'mb-1.5 block text-sm font-medium' }, 'Пароль'), input),
    error, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    error.classList.add('hidden');
    try {
      await call('POST', '/unlock', { password: input.value });
      start();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      input.select();
    } finally {
      submit.disabled = false;
    }
  });
  box.replaceChildren(form);
  input.focus();
}

async function download(key, button) {
  if (button) button.disabled = true;
  try {
    const { url } = await call('POST', '/download', key ? { key } : {});
    window.location.assign(url);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button) setTimeout(() => { button.disabled = false; }, 1500);
  }
}

// ---------- предпросмотр ----------
// Те же типы, что умеет сервер (keys.js previewKind); у ссылки с лимитом скачиваний — нет.
const PREVIEW_EXT = new Set(('png jpg jpeg gif webp avif bmp ico svg mp4 m4v webm ogv mov mp3 wav ogg oga m4a aac ' +
  'flac opus pdf txt md markdown csv tsv log json jsonl xml yml yaml toml ini conf cfg srt vtt').split(' '));
let previewAllowed = true;
const canPreview = (name) => previewAllowed && PREVIEW_EXT.has(extOf(name));

async function loadPreview(key) {
  const { kind, url } = await call('POST', '/preview', key ? { key } : {});
  if (kind === 'image') return h('img', { src: url, alt: '', class: 'mx-auto max-h-[70vh] max-w-full rounded-xl object-contain' });
  if (kind === 'video') return h('video', { src: url, controls: true, playsinline: true, preload: 'metadata', class: 'mx-auto max-h-[70vh] w-full rounded-xl bg-black' });
  if (kind === 'audio') return h('audio', { src: url, controls: true, preload: 'metadata', class: 'w-full' });
  if (kind === 'pdf') return h('iframe', { src: url, title: 'PDF', class: 'h-[70vh] w-full rounded-xl border border-slate-200 bg-white dark:border-slate-800' });
  const res = await fetch(url);
  if (!res.ok) throw new Error('Не удалось открыть файл');
  return h('pre', { class: 'max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-50 p-4 text-left text-xs leading-relaxed dark:bg-slate-950' }, await res.text());
}

function previewDialog(file) {
  const body = h('div', { class: 'flex min-h-[8rem] items-center justify-center' }, h('div', { class: 'h-24 w-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800' }));
  const dl = h('button', { type: 'button', class: 'btn-primary', onclick: () => download(file.key, dl) }, icon('download'), 'Скачать');
  const dialog = h('dialog', { class: 'w-[min(56rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl backdrop:bg-slate-950/60 dark:bg-slate-900 dark:text-slate-200' },
    h('div', { class: 'flex items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800' },
      h('p', { class: 'min-w-0 flex-1 truncate font-medium' }, file.name), dl,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => dialog.close() }, icon('close'))),
    h('div', { class: 'p-4' }, body));
  dialog.addEventListener('close', () => dialog.remove()); // и остановит видео
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  document.body.append(dialog);
  dialog.showModal();
  loadPreview(file.key).then((el) => body.replaceChildren(el)).catch((err) => {
    body.replaceChildren(h('p', { class: 'py-10 text-center text-sm text-slate-500' }, err.message));
  });
}

// ---------- файл ----------
function fileView(info) {
  previewAllowed = info.downloadsLeft == null;
  const btn = h('button', { type: 'button', class: 'btn-primary w-full py-3 text-base', onclick: () => download(null, btn) }, icon('download', 'h-5 w-5'), 'Скачать');
  const shown = h('div', { class: 'hidden' });
  if (canPreview(info.file.name)) {
    shown.className = 'flex min-h-[8rem] items-center justify-center';
    shown.append(h('div', { class: 'h-40 w-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800' }));
    loadPreview(null).then((el) => shown.replaceChildren(el)).catch(() => shown.replaceChildren());
  }
  box.replaceChildren(h('div', { class: 'space-y-6 text-center' },
    shown,
    !canPreview(info.file.name) && h('div', { class: 'flex justify-center' }, fileBadge(info.file.name, 'h-16 w-16 rounded-2xl', 'h-7 w-7')),
    h('div', {},
      h('h1', { class: 'break-words text-xl font-semibold' }, info.file.name),
      h('p', { class: 'mt-1 text-sm tabular-nums text-slate-500 dark:text-slate-400' },
        [formatSize(info.file.size), info.downloadsLeft != null && `осталось скачиваний: ${info.downloadsLeft}`].filter(Boolean).join(' · '))),
    btn));
}

// ---------- папка ----------
function folderView(info) {
  previewAllowed = !info.hasDownloadLimit;
  let sub = '';
  let cursor = null;
  const crumbs = h('nav', { class: 'flex min-w-0 flex-wrap items-center gap-1 text-sm', 'aria-label': 'Путь' });
  const list = h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' });
  const more = h('button', { type: 'button', class: 'btn-ghost hidden w-full', onclick: () => load(true) }, 'Показать ещё');
  const title = info.name.split(' / ').at(-1);
  box.replaceChildren(h('div', { class: 'space-y-4' },
    h('div', { class: 'flex items-center gap-3' },
      h('span', { class: 'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400' }, icon('folder', 'h-5 w-5')),
      h('h1', { class: 'min-w-0 truncate text-lg font-semibold' }, title)),
    crumbs, list, more));

  function renderCrumbs() {
    const parts = sub.split('/').filter(Boolean);
    const items = [h('button', { type: 'button', class: 'link', onclick: () => go('') }, title)];
    parts.forEach((p, i) => {
      items.push(icon('chevronRight', 'h-3.5 w-3.5 text-slate-300'));
      const path = `${parts.slice(0, i + 1).join('/')}/`;
      items.push(i === parts.length - 1 ? h('span', { class: 'font-medium' }, p) : h('button', { type: 'button', class: 'link', onclick: () => go(path) }, p));
    });
    crumbs.replaceChildren(...items);
    crumbs.classList.toggle('hidden', !parts.length);
  }
  const go = (path) => { sub = path; cursor = null; load(false); };

  async function load(append) {
    try {
      const res = await call('GET', `/list?folder=${encodeURIComponent(sub)}${append && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      cursor = res.nextCursor;
      const rows = [
        ...(append ? [] : res.folders.map((f) => h('li', {},
          h('button', { type: 'button', class: 'flex w-full items-center gap-3 px-2 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40', onclick: () => go(f.path) },
            h('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400' }, icon('folder')),
            h('span', { class: 'min-w-0 flex-1 truncate text-sm font-medium' }, f.name),
            icon('chevronRight', 'h-4 w-4 text-slate-400'))))),
        ...res.files.map((f) => {
          const btn = h('button', { type: 'button', class: 'icon-btn', title: 'Скачать', 'aria-label': `Скачать ${f.name}`, onclick: () => download(f.key, btn) }, icon('download'));
          // Файл, который можно посмотреть, открывается по клику на имя.
          const name = h('span', { class: 'min-w-0 flex-1' },
            h('span', { class: 'block truncate text-sm font-medium' }, f.name),
            h('span', { class: 'block text-xs tabular-nums text-slate-500 dark:text-slate-400' }, `${formatSize(f.size)} · ${formatDate(f.lastModified)}`));
          const main = canPreview(f.name)
            ? h('button', { type: 'button', class: 'flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left hover:text-brand-700 dark:hover:text-brand-300', title: 'Посмотреть', onclick: () => previewDialog(f) }, fileBadge(f.name), name)
            : h('span', { class: 'flex min-w-0 flex-1 items-center gap-3' }, fileBadge(f.name), name);
          return h('li', { class: 'flex items-center gap-3 px-2 py-2.5' }, main, btn);
        }),
      ];
      if (append) list.append(...rows);
      else list.replaceChildren(...(rows.length ? rows : [h('li', { class: 'px-2 py-10 text-center text-sm text-slate-500' }, 'Папка пуста')]));
      more.classList.toggle('hidden', !cursor);
      renderCrumbs();
    } catch (err) {
      if (err.status === 401) return start();
      toast(err.message, 'error');
    }
  }
  load(false);
}

// ---------- «загрузить мне» ----------
function uploadView(info) {
  const client = {
    startUpload: (file) => call('POST', '/upload', { name: file.name, size: file.size, type: file.type }),
    partUrls: (key, uploadId, partNumbers) => call('POST', '/upload/parts', { key, uploadId, partNumbers }),
    completeUpload: (key, uploadId) => call('POST', '/upload/complete', { key, uploadId, from: sender.value.trim() }),
    abortUpload: (key, uploadId) => call('POST', '/upload/abort', { key, uploadId }),
  };
  const input = h('input', { type: 'file', multiple: true, class: 'sr-only', id: 'share-files' });
  // «От кого» — необязательно; владелец увидит имя в статистике портала.
  let saved = '';
  try { saved = localStorage.getItem('fm-sender') ?? ''; } catch { /* приватный режим */ }
  const sender = h('input', { id: 'share-sender', type: 'text', class: 'input', maxlength: 100, autocomplete: 'name', placeholder: 'необязательно', value: saved });
  sender.addEventListener('change', () => { try { localStorage.setItem('fm-sender', sender.value.trim()); } catch { /* не критично */ } });
  // Запрос файла: срок и кнопка «Готово» (после неё ссылка закрывается).
  const daysLeft = info.expiresAt ? Math.ceil((Date.parse(info.expiresAt) - Date.now()) / 86_400_000) : null;
  const due = info.request && info.expiresAt && h('p', { class: `rounded-xl px-4 py-2.5 text-center text-sm ${daysLeft <= 1 ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200' : 'bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300'}` },
    `Нужно прислать до ${formatDate(info.expiresAt)}`, daysLeft > 0 ? ` · осталось ${daysLeft} дн.` : '');
  const finish = h('button', { type: 'button', class: 'btn-primary hidden w-full py-3 text-base', onclick: finishRequest }, icon('check', 'h-5 w-5'), 'Готово — отправить');
  async function finishRequest() {
    finish.disabled = true;
    try {
      await call('POST', '/finish');
      message('check', 'Спасибо! Файлы отправлены', 'Ссылка закрыта — больше ничего делать не нужно.', 'bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400');
    } catch (err) {
      toast(err.message, 'error');
      finish.disabled = false;
    }
  }
  const list = h('ul', { class: 'space-y-2' });
  const limits = [`до ${formatSize(info.maxFileSize)} на файл`, info.uploadsLeft != null && `ещё ${info.uploadsLeft} файлов`].filter(Boolean).join(' · ');
  // Портал: большая кнопка-зона и подпись владельца ссылки.
  const zone = h('label', { for: 'share-files', class: 'group flex cursor-pointer flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-slate-300 px-6 py-12 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/50 dark:border-slate-700 dark:hover:border-brand-600 dark:hover:bg-brand-950/30' },
    h('span', { class: 'flex h-20 w-20 items-center justify-center rounded-3xl bg-brand-600 text-white shadow-lg shadow-brand-600/20 transition-transform group-hover:-translate-y-0.5 group-active:scale-95' }, icon('upload', 'h-9 w-9')),
    h('span', { class: 'text-lg font-semibold' }, info.caption || 'Загрузить файлы'),
    h('span', { class: 'text-sm text-slate-500 dark:text-slate-400' }, 'Нажмите или перетащите файлы'),
    h('span', { class: 'text-xs text-slate-400' }, limits));
  box.replaceChildren(h('div', { class: 'space-y-5' }, due, zone, input,
    h('div', {}, h('label', { for: 'share-sender', class: 'mb-1.5 block text-sm font-medium' }, 'Ваше имя'), sender),
    list, info.request && finish));

  const queue = [];
  let running = false;
  function add(files) {
    for (const file of files) {
      const status = h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500' }, 'в очереди');
      const bar = h('div');
      // Миниатюра: картинка из самого файла (без загрузки на сервер), у остальных — значок типа.
      const thumb = fileBadge(file.name);
      if (file.type.startsWith('image/') && file.size <= 8 * 1024 * 1024) {
        const reader = new FileReader();
        reader.onload = () => thumb.replaceWith(h('img', { src: reader.result, alt: '', class: 'h-9 w-9 shrink-0 rounded-lg object-cover' }));
        reader.readAsDataURL(file);
      }
      list.append(h('li', { class: 'upload-row flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800' },
        thumb,
        h('div', { class: 'min-w-0 flex-1' },
          h('div', { class: 'flex items-baseline justify-between gap-3' }, h('p', { class: 'truncate text-sm font-medium' }, file.name), status),
          h('div', { class: 'progress mt-2' }, bar))));
      if (file.size > info.maxFileSize) {
        status.textContent = 'слишком большой';
        status.classList.add('text-rose-600');
        bar.parentElement.classList.add('is-error');
        continue;
      }
      queue.push({ file, status, bar });
    }
    pump();
  }
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const { file, status, bar } = queue.shift();
      const progress = new ProgressView(bar, status, file.size);
      try {
        await uploadFile(file, { client, signal: new AbortController().signal, onProgress: (n) => progress.update(n) });
        progress.finish(true);
        status.textContent = 'Загружено';
        finish.classList.remove('hidden');
      } catch (err) {
        if (err instanceof UploadCancelled) continue;
        progress.finish(false);
        status.textContent = 'Ошибка';
        status.classList.add('text-rose-600');
        toast(`${file.name}: ${err.message}`, 'error');
        if (err.status === 410) { queue.length = 0; break; }
      }
    }
    running = false;
  }
  input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('border-brand-500'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('border-brand-500'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('border-brand-500'); add([...e.dataTransfer.files]); });
}

start();
