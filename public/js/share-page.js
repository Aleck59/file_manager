// Страница публичной ссылки /s/<id>: скачать файл, открыть папку или загрузить файлы
// владельцу («загрузить мне»). Работает без входа; пароль ссылки — через /unlock.
import { ProgressView } from './progress.js';
import { UploadCancelled, uploadFile } from './uploader.js';
import { $, fileBadge, formatDate, formatSize, h, icon, toast } from './ui.js';

const id = location.pathname.split('/').filter(Boolean)[1] ?? '';
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

// ---------- файл ----------
function fileView(info) {
  const btn = h('button', { type: 'button', class: 'btn-primary w-full py-3 text-base', onclick: () => download(null, btn) }, icon('download', 'h-5 w-5'), 'Скачать');
  box.replaceChildren(h('div', { class: 'space-y-6 text-center' },
    h('div', { class: 'flex justify-center' }, fileBadge(info.file.name, 'h-16 w-16 rounded-2xl', 'h-7 w-7')),
    h('div', {},
      h('h1', { class: 'break-words text-xl font-semibold' }, info.file.name),
      h('p', { class: 'mt-1 text-sm tabular-nums text-slate-500 dark:text-slate-400' },
        [formatSize(info.file.size), info.downloadsLeft != null && `осталось скачиваний: ${info.downloadsLeft}`].filter(Boolean).join(' · '))),
    btn));
}

// ---------- папка ----------
function folderView(info) {
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
          return h('li', { class: 'flex items-center gap-3 px-2 py-2.5' },
            fileBadge(f.name),
            h('span', { class: 'min-w-0 flex-1' },
              h('span', { class: 'block truncate text-sm font-medium' }, f.name),
              h('span', { class: 'block text-xs tabular-nums text-slate-500 dark:text-slate-400' }, `${formatSize(f.size)} · ${formatDate(f.lastModified)}`)),
            btn);
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
    completeUpload: (key, uploadId) => call('POST', '/upload/complete', { key, uploadId }),
    abortUpload: (key, uploadId) => call('POST', '/upload/abort', { key, uploadId }),
  };
  const input = h('input', { type: 'file', multiple: true, class: 'sr-only', id: 'share-files' });
  const list = h('ul', { class: 'space-y-2' });
  const limits = [`до ${formatSize(info.maxFileSize)} на файл`, info.uploadsLeft != null && `ещё ${info.uploadsLeft} файлов`].filter(Boolean).join(' · ');
  const zone = h('label', { for: 'share-files', class: 'flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-slate-300 px-6 py-10 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/50 dark:border-slate-700 dark:hover:border-brand-600 dark:hover:bg-brand-950/30' },
    h('span', { class: 'flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400' }, icon('upload', 'h-6 w-6')),
    h('span', { class: 'font-medium' }, 'Перетащите файлы сюда или ', h('span', { class: 'text-brand-600 dark:text-brand-400' }, 'выберите')),
    h('span', { class: 'text-xs text-slate-500 dark:text-slate-400' }, limits));
  box.replaceChildren(h('div', { class: 'space-y-5' },
    h('div', { class: 'text-center' },
      h('h1', { class: 'text-xl font-semibold' }, 'Загрузить файлы'),
      h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' }, `Файлы получит ${info.owner}. Вы их видеть не будете — только загрузить.`)),
    zone, input, list));

  const queue = [];
  let running = false;
  function add(files) {
    for (const file of files) {
      const status = h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500' }, 'в очереди');
      const bar = h('div');
      list.append(h('li', { class: 'upload-row rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800' },
        h('div', { class: 'flex items-baseline justify-between gap-3' }, h('p', { class: 'truncate text-sm font-medium' }, file.name), status),
        h('div', { class: 'progress mt-2' }, bar)));
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
