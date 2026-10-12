import { api } from './api.js';
import { uploadFile, UploadCancelled } from './uploader.js';

const FILE_CONCURRENCY = 2;

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  uploadList: $('upload-list'),
  fileList: $('file-list'),
  summary: $('files-summary'),
  empty: $('empty-state'),
  skeleton: $('list-skeleton'),
  loadMoreWrap: $('load-more-wrap'),
  loadMore: $('load-more'),
  search: $('search'),
  linkTtl: $('link-ttl'),
  refresh: $('refresh'),
  logout: $('logout'),
  dialog: $('confirm-dialog'),
  confirmName: $('confirm-name'),
  toasts: $('toasts'),
  fileRowTpl: $('file-row'),
  uploadRowTpl: $('upload-row'),
};

const state = { files: [], cursor: null, loading: false };

// ---------- форматирование ----------
const sizeFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
function formatSize(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${sizeFmt.format(n)} ${units[i]}`;
}
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const plural = new Intl.PluralRules('ru-RU');
const FILE_WORDS = { one: 'файл', few: 'файла', many: 'файлов', other: 'файла' };
const filesWord = (n) => FILE_WORDS[plural.select(n)];
const formatDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.length - dot <= 5 ? name.slice(dot + 1) : 'file';
}

// ---------- уведомления ----------
function toast(message, type = 'info') {
  const el = document.createElement('div');
  const palette = {
    info: 'bg-slate-900 text-white dark:bg-white dark:text-slate-900',
    success: 'bg-brand-700 text-white',
    error: 'bg-rose-600 text-white',
  };
  el.className = `pointer-events-auto max-w-md animate-toast-in rounded-xl px-4 py-2.5 text-sm shadow-lg ${palette[type]}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message; // только textContent — никакого HTML из данных
  els.toasts.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

// ---------- список файлов ----------
function renderFiles() {
  const query = els.search.value.trim().toLowerCase();
  const visible = query ? state.files.filter((f) => f.name.toLowerCase().includes(query)) : state.files;

  const fragment = document.createDocumentFragment();
  for (const file of visible) {
    const row = els.fileRowTpl.content.firstElementChild.cloneNode(true);
    row.dataset.key = file.key;
    row.querySelector('[data-ext]').textContent = extOf(file.name).slice(0, 4);
    const nameEl = row.querySelector('[data-name]');
    nameEl.textContent = file.name;
    nameEl.title = file.name;
    row.querySelector('[data-size]').textContent = formatSize(file.size);
    row.querySelector('[data-date]').textContent = formatDate(file.lastModified);
    row.querySelector('[data-meta]').textContent = `${formatSize(file.size)} · ${formatDate(file.lastModified)}`;
    fragment.append(row);
  }
  els.fileList.replaceChildren(fragment);

  const total = state.files.reduce((sum, f) => sum + f.size, 0);
  const more = state.cursor ? '+' : '';
  els.summary.textContent = state.files.length
    ? `${state.files.length}${more} ${filesWord(state.files.length)} · ${formatSize(total)}${more}`
    : 'Нет файлов';
  els.empty.classList.toggle('hidden', state.files.length > 0 || state.loading);
  els.loadMoreWrap.classList.toggle('hidden', !state.cursor);
}

async function loadFiles({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  els.refresh.disabled = els.loadMore.disabled = true;
  try {
    const { files, nextCursor } = await api.listFiles(append ? state.cursor : null);
    state.files = append ? state.files.concat(files) : files;
    state.cursor = nextCursor;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.loading = false;
    els.skeleton.classList.add('hidden');
    els.refresh.disabled = els.loadMore.disabled = false;
    renderFiles();
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Фолбэк для старых браузеров / небезопасного контекста.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'fixed -left-[9999px]';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Не удалось скопировать ссылку');
  }
}

function confirmDelete(name) {
  els.confirmName.textContent = name;
  els.dialog.returnValue = '';
  els.dialog.showModal();
  return new Promise((resolve) => {
    els.dialog.addEventListener('close', () => resolve(els.dialog.returnValue === 'confirm'), { once: true });
  });
}

els.fileList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('li');
  const file = state.files.find((f) => f.key === row.dataset.key);
  if (!file) return;

  button.disabled = true;
  try {
    switch (button.dataset.action) {
      case 'download': {
        const { url } = await api.downloadLink(file.key, 3600);
        // Ссылка отдаётся с Content-Disposition: attachment — страница не уходит.
        window.location.assign(url);
        break;
      }
      case 'copy': {
        const ttl = Number(els.linkTtl.value);
        const { url } = await api.downloadLink(file.key, ttl);
        await copyToClipboard(url);
        toast(`Ссылка скопирована · действует ${els.linkTtl.selectedOptions[0].textContent}`, 'success');
        break;
      }
      case 'delete': {
        if (!(await confirmDelete(file.name))) break;
        await api.deleteFile(file.key);
        state.files = state.files.filter((f) => f.key !== file.key);
        renderFiles();
        toast('Файл удалён', 'success');
        break;
      }
    }
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 404) loadFiles();
  } finally {
    button.disabled = false;
  }
});

// ---------- загрузка ----------
const queue = [];
let active = 0;

function addUploadRow(file) {
  const row = els.uploadRowTpl.content.firstElementChild.cloneNode(true);
  row.querySelector('[data-name]').textContent = file.name;
  const status = row.querySelector('[data-status]');
  const bar = row.querySelector('[data-bar]');
  const cancel = row.querySelector('[data-action="cancel"]');
  status.textContent = `${formatSize(file.size)} · в очереди`;
  els.uploadList.append(row);
  return { row, status, bar, cancel };
}

function enqueue(files) {
  for (const file of files) {
    const controller = new AbortController();
    const ui = addUploadRow(file);
    ui.cancel.addEventListener('click', () => controller.abort(), { once: true });
    queue.push({ file, controller, ui });
  }
  pump();
}

function pump() {
  while (active < FILE_CONCURRENCY && queue.length) {
    active++;
    runUpload(queue.shift()).finally(() => {
      active--;
      pump();
    });
  }
}

async function runUpload({ file, controller, ui }) {
  const { status, bar, row, cancel } = ui;
  if (controller.signal.aborted) {
    row.remove();
    return;
  }
  const started = performance.now();
  try {
    const result = await uploadFile(file, {
      signal: controller.signal,
      onProgress(loaded, total) {
        const pct = total ? Math.min(100, (loaded / total) * 100) : 100;
        bar.style.width = `${pct}%`; // CSSOM разрешён CSP, в отличие от inline style
        const seconds = (performance.now() - started) / 1000;
        const speed = seconds > 0.5 ? ` · ${formatSize(loaded / seconds)}/с` : '';
        status.textContent = `${Math.floor(pct)}%${speed}`;
      },
    });
    bar.style.width = '100%';
    status.textContent = 'Готово';
    cancel.remove();
    if (!state.files.some((f) => f.key === result.key)) state.files.unshift(result);
    renderFiles();
    setTimeout(() => row.remove(), 2500);
  } catch (err) {
    if (err instanceof UploadCancelled) {
      row.remove();
      return;
    }
    bar.classList.add('!bg-rose-500');
    bar.style.width = '100%';
    status.textContent = 'Ошибка';
    status.classList.add('text-rose-600');
    cancel.title = 'Скрыть';
    cancel.addEventListener('click', () => row.remove(), { once: true });
    toast(`${file.name}: ${err.message}`, 'error');
  }
}

// Предупреждаем, если пользователь закрывает вкладку во время загрузки.
window.addEventListener('beforeunload', (event) => {
  if (active > 0 || queue.length > 0) event.preventDefault();
});

els.fileInput.addEventListener('change', () => {
  enqueue([...els.fileInput.files]);
  els.fileInput.value = '';
});

// Drag-and-drop: счётчик нужен, т.к. dragenter/dragleave срабатывают на дочерних элементах.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  els.dropzone.classList.add('dropzone-active');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropzone.classList.remove('dropzone-active');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove('dropzone-active');
  // Папки отфильтровываем: загружаем только сами файлы.
  const files = [...e.dataTransfer.items]
    .filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length) enqueue(files);
  else toast('Папки не поддерживаются — перетащите сами файлы', 'error');
});

// ---------- прочее ----------
els.search.addEventListener('input', renderFiles);
els.refresh.addEventListener('click', () => loadFiles());
els.loadMore.addEventListener('click', () => loadFiles({ append: true }));
els.logout.addEventListener('click', async () => {
  await api.logout().catch(() => {});
  window.location.replace('/login');
});

loadFiles();
