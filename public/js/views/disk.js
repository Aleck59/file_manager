// Раздел «Диск»: содержимое папки в виде списка или плиток, хлебные крошки, сортировка,
// выбор нескольких файлов и действия над ними, загрузка (кнопка, перетаскивание файлов
// и папок целиком, вставка из буфера обмена), переименование, перемещение и удаление,
// управление с клавиатуры.
import { api } from '../api.js';
import { closePreview, copyFileLink, isPreviewing, setPreviewEnabled, showPreview, TTL_LABELS } from '../preview.js';
import { pickFolder } from '../folder-picker.js';
import { openShareDialog } from '../share-dialog.js';
import { forgetFolder, isFavorite, refolderInLibrary, rememberOpened, removeFromLibrary, renameInLibrary, toggleFavorite } from '../library.js';
import { labelDot, labelMenuItem } from '../labels.js';
import { searchHash } from './search.js';
import { folderId } from '../folder-id.js';
import { openAclDialog } from '../acl-dialog.js';
import { forgetThumb, thumbnail } from '../thumbs.js';
import * as tree from '../tree.js';
import {
  categoryOf, confirmDialog, copyToClipboard, DRAG_TYPE, FILES, FOLDER_ICONS, FOLDER_TONES, folderIconName, folderLabel, FOLDERS, folderTone, formatDate, formatDateShort, formatSize, h, homeFolder, icon,
  makeDropTarget, openDialog, openMenu, pluralize, prefs, toast, toned,
} from '../ui.js';

// Адрес папки: #/disk/<ID папки>[/<ID файла>] — короткий при любой глубине вложенности.
// ID папки — хеш пути (folder-id.js); соответствие запоминается, чтобы не спрашивать сервер.
const knownIds = new Map();
try {
  for (const [id, path] of JSON.parse(sessionStorage.getItem('fm-folder-ids') ?? '[]')) knownIds.set(id, path);
} catch { /* приватный режим */ }
let saveIdsTimer;
const saveIds = () => {
  clearTimeout(saveIdsTimer);
  saveIdsTimer = setTimeout(() => {
    try { sessionStorage.setItem('fm-folder-ids', JSON.stringify([...knownIds].slice(-2000))); } catch { /* не критично */ }
  }, 500);
};
// ID файла — случайная часть его ключа («…-<16 символов>~имя»): постоянна при переименовании.
export const fileShortId = (key) => /-([A-Za-z0-9_-]{16})~/.exec(key)?.[1] ?? null;
export function diskHash(folder, fileKey) {
  if (!folder && !fileKey) return '#/disk/';
  const id = folder ? folderId(folder) : 'root';
  if (folder && knownIds.get(id) !== folder) { knownIds.set(id, folder); saveIds(); }
  const file = fileKey && fileShortId(fileKey);
  return `#/disk/${id}${file ? `/${file}` : ''}`;
}
export const pathForId = (id) => (id === 'root' ? '' : knownIds.get(id));
export const rememberFolderId = (id, path) => { knownIds.set(id, path); saveIds(); };

export function storageNotice(ctx) {
  return h('div', { class: 'mx-auto max-w-xl px-6 py-20 text-center' },
    h('span', { class: 'mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400' }, icon('server', 'h-6 w-6')),
    h('p', { class: 'text-lg font-semibold' }, 'Хранилище не настроено'),
    h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' },
      ctx.can('admin') ? 'Укажите параметры S3-хранилища — после этого здесь появятся файлы.' : 'Администратор ещё не подключил хранилище файлов.'),
    ctx.can('admin') && h('a', { href: '#/settings', class: 'btn-primary mt-6' }, icon('settings'), 'Открыть настройки'));
}

const FOLDER_DRAG = 'application/x-fm-folder'; // перетаскивание папок внутри диска
const dragUrls = new Map(); // ключ файла → {url, until} — для перетаскивания на рабочий стол

// Буфер обмена диска (Ctrl+C / Ctrl+X → Ctrl+V) и история для отмены (Ctrl+Z):
// живут, пока открыта вкладка, — переходы по папкам их не сбрасывают.
const clip = { data: null }; // {mode: 'copy'|'cut', files: [{key, name}], folders: [{path, name}], from}
const undoStack = []; // [{label, run}]
function pushUndo(label, run) {
  undoStack.push({ label, run });
  if (undoStack.length > 30) undoStack.shift();
}

// ---------- группы по дате ----------
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const DATE_GROUPS = [
  { label: 'Сегодня', test: (iso) => iso && new Date(iso) >= startOfDay() },
  { label: 'На этой неделе', test: (iso) => { // с понедельника
    const d = startOfDay();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return iso && new Date(iso) >= d;
  } },
  { label: 'В этом месяце', test: (iso) => { const n = new Date(); return iso && new Date(iso) >= new Date(n.getFullYear(), n.getMonth(), 1); } },
  { label: 'Раньше', test: () => true },
];

// ---------- сортировка ----------
const SORTS = {
  date: { label: 'Дата изменения', cmp: (a, b) => String(a.lastModified).localeCompare(String(b.lastModified)) },
  name: { label: 'Имя', cmp: (a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }) },
  size: { label: 'Размер', cmp: (a, b) => a.size - b.size },
};
const DEFAULT_DIR = { date: 'desc', name: 'asc', size: 'desc' };

// ---------- загрузка папок целиком ----------
const MAX_DROPPED_FILES = 5000;
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Файлы из перетащенных элементов, включая содержимое папок: [{file, subfolders}]. */
async function collectDropped(dataTransfer) {
  // webkitGetAsEntry нужно вызвать синхронно, пока событие drop не завершилось.
  const items = [...dataTransfer.items].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const out = [];
  if (entries.some((e) => !e)) {
    for (const f of dataTransfer.files) out.push({ file: f, subfolders: [] });
    return out;
  }
  const readAll = (reader) => new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      next();
    }, reject);
    next();
  });
  async function walk(entry, path) {
    if (out.length >= MAX_DROPPED_FILES) return;
    if (entry.isFile) {
      if (SKIP_FILES.has(entry.name)) return;
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, subfolders: path });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, [...path, entry.name]);
    }
  }
  for (const entry of entries) await walk(entry, []);
  return out;
}

// Скриншот из буфера обмена приходит как «image.png» — даём понятное имя с датой.
function pastedName(file) {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name;
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Снимок ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.${ext}`;
}

// Ввод текста (горячие клавиши не перехватываем); флажки и переключатели — не ввод.
const isTyping = (el) => el && (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName)
  || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range'].includes(el.type)));

export function mountDisk(view, ctx, folder, { selectKey, selectId } = {}) {
  if (!ctx.storageConfigured) {
    ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Мой диск'), []);
    view.replaceChildren(storageNotice(ctx));
    return { unmount() {} };
  }
  const canEdit = ctx.can('editor');
  const [sortBy, sortDir] = prefs.get('sort', 'date-desc').split('-');
  const state = {
    folders: [], files: [], cursor: null, loading: false, query: '',
    selected: selectKey ?? null, // файл в панели предпросмотра
    checked: new Set(), // выбранные (несколько) файлы — ключи
    checkedFolders: new Set(), // выбранные папки — пути
    anchor: null, // для выбора диапазона с Shift
    layout: prefs.get('layout', 'list') === 'grid' ? 'grid' : 'list',
    sort: SORTS[sortBy] ? { by: sortBy, dir: sortDir === 'asc' ? 'asc' : 'desc' } : { by: 'date', dir: 'desc' },
    mixed: prefs.get('mixed', '0') === '1', // папки вперемешку с файлами
    group: prefs.get('group-date', '0') === '1', // группы по дате: сегодня, на неделе, в месяце, раньше
  };
  const cleanup = [];
  let unmounted = false;
  let density = prefs.get('density', 'normal') === 'compact' ? 'compact' : 'normal';
  let tileSize = ['s', 'm', 'l'].includes(prefs.get('tile-size', 'm')) ? prefs.get('tile-size', 'm') : 'm';
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanup.push(() => target.removeEventListener(type, fn, opts)); };

  setPreviewEnabled(true);
  if (canEdit) tree.setDropHandler((keys, path) => moveByKeys(keys, path));
  // Правый клик по папке в дереве слева — то же меню, что у папки в списке.
  tree.setMenuHandler((f, anchor) => folderMenu(f)(anchor));
  tree.reveal(folder);
  ctx.onPreviewClosed = () => {
    state.selected = null;
    markSelection();
    if (!unmounted) history.replaceState(null, '', diskHash(folder));
  };
  ctx.onPreviewMissing = () => load();
  ctx.onCommentsChanged = (key, n) => {
    const f = state.files.find((x) => x.key === key);
    if (f) { f.comments = n || undefined; renderList(); }
  };

  // ---------- заголовок: хлебные крошки + действия ----------
  // Крошки начинаются с корня диска пользователя (у кого личная папка — с неё).
  const crumbs = [['Мой диск', homeFolder]];
  let acc = homeFolder;
  for (const seg of folder.slice(homeFolder.length).split('/').filter(Boolean)) { acc += `${seg}/`; crumbs.push([seg, acc]); }
  const breadcrumb = h('nav', { 'aria-label': 'Путь', class: 'flex min-w-0 items-center gap-1 text-sm' },
    crumbs.flatMap(([label, path], i) => {
      const last = i === crumbs.length - 1;
      const item = last
        ? h('span', { class: 'truncate font-semibold text-slate-900 dark:text-white', 'aria-current': 'page' }, label)
        : h('a', { href: diskHash(path), class: 'shrink-0 truncate rounded px-1 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white max-w-[10rem]' }, label);
      // Файл можно перетащить на родительскую папку в хлебных крошках.
      if (!last && canEdit) makeDropTarget(item, (keys) => moveByKeys(keys, path));
      return i === 0 ? [item] : [icon('chevronRight', 'h-3.5 w-3.5 text-slate-300 dark:text-slate-600'), item];
    }));
  // На узких экранах показываем только последнюю пару крошек.
  if (crumbs.length > 2) breadcrumb.firstElementChild.classList.add('hidden', 'sm:block');

  ctx.setHeader(breadcrumb, canEdit ? [
    h('button', { type: 'button', class: 'btn-ghost', onclick: () => openShareDialog({ folder }), title: 'Поделиться этой папкой' }, toned('globe'), h('span', { class: 'hidden lg:inline' }, 'Поделиться')),
    h('button', { type: 'button', class: 'btn-ghost', onclick: newFolder, title: 'Новая папка' }, toned('folderPlus'), h('span', { class: 'hidden md:inline' }, 'Папка')),
    h('button', { type: 'button', class: 'btn-primary', onclick: () => ctx.pickFiles(folder) }, icon('upload'), h('span', { class: 'hidden sm:inline' }, 'Загрузить')),
  ] : []);

  // ---------- панель инструментов ----------
  const search = h('input', { type: 'search', placeholder: 'Поиск в папке', 'aria-label': 'Поиск в папке', 'aria-keyshortcuts': '/',
    class: 'input py-1.5 pl-9', oninput: (e) => { state.query = e.target.value.trim().toLowerCase(); renderList(); } });
  const summary = h('p', { class: 'text-sm tabular-nums text-slate-500 dark:text-slate-400' }, 'Загрузка…');

  const sortBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-haspopup': 'menu', onclick: (e) => openSortMenu(e.currentTarget) }, icon('sort'));
  const layoutBtns = ['list', 'grid'].map((layout) => h('button', {
    type: 'button', 'aria-pressed': String(state.layout === layout), title: layout === 'list' ? 'Списком' : 'Плитками',
    'aria-label': layout === 'list' ? 'Показывать списком' : 'Показывать плитками',
    onclick: () => setLayout(layout),
  }, icon(layout === 'list' ? 'list' : 'grid')));
  const layoutSwitch = h('div', { class: 'segmented segmented-icons', role: 'group', 'aria-label': 'Вид' }, layoutBtns);

  const toolbar = h('div', { class: 'flex items-center gap-2' },
    h('div', { class: 'search-box relative min-w-0 flex-1 sm:w-56 sm:flex-none' },
      h('span', { class: 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400' }, icon('search')),
      search),
    sortBtn, layoutSwitch,
    h('button', { type: 'button', class: 'icon-btn hidden sm:inline-flex', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, icon('refresh')));

  // Панель действий над выбранными файлами — появляется вместо сводки.
  const bulkCount = h('span', { class: 'whitespace-nowrap text-sm font-medium tabular-nums' });
  const bulkBar = h('div', { class: 'bulk-bar hidden min-w-0 items-center gap-1', role: 'toolbar', 'aria-label': 'Действия с выбранными файлами' },
    h('button', { type: 'button', class: 'icon-btn', title: 'Снять выбор (Esc)', 'aria-label': 'Снять выбор', onclick: () => clearChecked() }, icon('close')),
    bulkCount,
    h('span', { class: 'mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700' }),
    h('button', { type: 'button', class: 'btn-ghost px-2.5 py-1.5', title: 'Скачать одним ZIP', onclick: () => downloadZip(selectionForZip()) }, toned('download'), h('span', { class: 'hidden xl:inline' }, 'ZIP')),
    h('button', { type: 'button', class: 'files-only btn-ghost px-2.5 py-1.5', title: 'Ссылки на выбранные файлы', onclick: () => bulkCopyLinks() }, toned('link'), h('span', { class: 'hidden xl:inline' }, 'Ссылки')),
    canEdit && h('button', { type: 'button', class: 'btn-ghost px-2.5 py-1.5', onclick: () => bulkMove() }, toned('move'), h('span', { class: 'hidden xl:inline' }, 'Переместить')),
    canEdit && h('button', { type: 'button', class: 'btn-ghost px-2.5 py-1.5', title: 'Копировать', 'aria-label': 'Копировать выбранные', onclick: () => bulkCopy() }, toned('copy'), h('span', { class: 'hidden 2xl:inline' }, 'Копировать')),
    canEdit && ctx.storages.length > 1 && h('button', { type: 'button', class: 'files-only btn-ghost px-2.5 py-1.5', title: 'Перенести в другое хранилище', 'aria-label': 'Перенести выбранные в другое хранилище', onclick: () => transferFiles(checkedFiles()) }, toned('server')),
    canEdit && h('button', { type: 'button', class: 'btn-ghost px-2.5 py-1.5 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950', onclick: () => bulkDelete() }, icon('trash'), h('span', { class: 'hidden xl:inline' }, 'Удалить')));

  // ---------- разметка ----------
  const list = h('ul', { class: 'file-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Содержимое папки' });
  const empty = h('div', { class: 'hidden px-6 py-16 text-center' });
  const skeleton = h('div', { class: 'space-y-3 p-4', 'aria-hidden': 'true' },
    [1, 2, 3, 4].map(() => h('div', { class: 'h-10 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800' })));
  const loadMore = h('button', { type: 'button', class: 'btn-ghost', onclick: () => load({ append: true }) }, 'Показать ещё');
  const loadMoreWrap = h('div', { class: 'hidden border-t border-slate-200 p-3 text-center dark:border-slate-800' }, loadMore);
  // Предупреждение, если какое-то из хранилищ единого диска сейчас не отвечает.
  const warnBox = h('div', { class: 'hidden items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200', role: 'status' });
  const showWarnings = (warnings = []) => {
    warnBox.classList.toggle('hidden', !warnings.length);
    warnBox.classList.toggle('flex', warnings.length > 0);
    warnBox.replaceChildren(icon('alert', 'mt-0.5 h-4 w-4'), h('span', {},
      warnings.map((w) => `Хранилище «${w.storage}» недоступно (${w.error}).`).join(' '),
      ' Его файлы временно не показаны.'));
  };
  // Метка хранилища у файла — только когда хранилищ несколько.
  const storageChip = (file) => ctx.storages.length > 1 && h('span', {
    class: 'badge hidden shrink-0 bg-slate-100 text-slate-500 sm:inline-flex dark:bg-slate-800 dark:text-slate-400',
    title: 'Хранилище, в котором лежит файл',
  }, ctx.storageName(file.storage));

  // Шапка таблицы: «выбрать всё» и сортировка по столбцам.
  const checkAll = h('input', { type: 'checkbox', class: 'check', 'aria-label': 'Выбрать все файлы', onchange: (e) => (e.target.checked ? checkAllFiles() : clearChecked()) });
  const sortHeader = (by, label, cls = '') => h('button', {
    type: 'button', class: `sort-head ${cls}`, dataset: { sort: by }, onclick: () => setSort(by),
  }, label, icon('arrowDown', 'sort-arrow h-3 w-3'));
  // ---------- столбцы: ширина и порядок ----------
  // Ширина — перетаскиванием границ в шапке (двойной щелчок — как было), порядок «Имя / Размер /
  // Изменён» — перетаскиванием заголовка на место другого. «Действия» всегда последние.
  // У «Имени» нет своей ширины: оно занимает всё, что осталось. Всё запоминается в браузере.
  const COLS = { name: [0, 0, 0], size: [104, 56, 320], date: [144, 96, 320], actions: [120, 80, 220] }; // по умолчанию, мин, макс (px)
  const LABELS = { name: 'Имя', size: 'Размер', date: 'Изменён', actions: 'Действия' };
  const CELL_INDEX = { name: 0, size: 1, date: 2, actions: 3 }; // порядок ячеек в разметке строки
  const widths = (() => {
    const saved = prefs.get('columns', '').split(',').map(Number);
    return Object.fromEntries(['size', 'date', 'actions'].map((k, i) => [k, saved[i] > 0 ? saved[i] : COLS[k][0]]));
  })();
  let order = (() => {
    const saved = prefs.get('column-order', '').split(',');
    const movable = ['name', 'size', 'date'];
    return saved.length === 3 && movable.every((k) => saved.includes(k)) ? [...saved, 'actions'] : [...movable, 'actions'];
  })();
  const clampCol = (k, v) => Math.round(Math.min(COLS[k][2], Math.max(COLS[k][1], v)));
  const track = (k) => (k === 'name' ? 'minmax(8rem, 1fr)' : `${widths[k]}px`);
  function applyColumns(save = true) {
    card.style.setProperty('--cols', order.map(track).join(' '));
    order.forEach((k, i) => card.style.setProperty(`--o-${CELL_INDEX[k] + 1}`, String(i + 1)));
    if (save) {
      prefs.set('columns', ['size', 'date', 'actions'].map((k) => widths[k]).join(','));
      prefs.set('column-order', order.slice(0, 3).join(','));
    }
  }
  // Граница между столбцами left и right: тянем вправо — left шире, right уже (кроме «Имени»).
  function resize(left, right, dx, start) {
    if (left !== 'name') widths[left] = clampCol(left, start[left] + dx);
    if (right !== 'name') widths[right] = clampCol(right, start[right] - (left !== 'name' ? widths[left] - start[left] : dx));
  }
  function resizer(left, right) {
    const handle = h('span', {
      class: 'col-resizer', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',
      'aria-label': `Граница столбцов «${LABELS[left]}» и «${LABELS[right]}»`, title: 'Потяните, чтобы изменить ширину · двойной щелчок — как было',
    });
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    handle.addEventListener('click', stop);
    handle.addEventListener('dragstart', stop);
    handle.addEventListener('dblclick', (e) => {
      stop(e);
      for (const k of [left, right]) if (k !== 'name') widths[k] = COLS[k][0];
      applyColumns();
    });
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      stop(e);
      resize(left, right, e.key === 'ArrowRight' ? 16 : -16, { ...widths });
      applyColumns();
    });
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      stop(e);
      const x0 = e.clientX;
      const start = { ...widths };
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('is-dragging');
      document.body.classList.add('is-col-resizing');
      const onMove = (ev) => { resize(left, right, ev.clientX - x0, start); applyColumns(false); };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.classList.remove('is-dragging');
        document.body.classList.remove('is-col-resizing');
        applyColumns();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp, { once: true });
      handle.addEventListener('pointercancel', onUp, { once: true });
    });
    return handle;
  }

  const headCells = {
    name: h('span', { class: 'col-cell flex items-center gap-3' }, h('span', { class: 'check-cell' }, checkAll), sortHeader('name', 'Имя')),
    size: h('span', { class: 'col-cell flex justify-end' }, sortHeader('size', 'Размер')),
    date: h('span', { class: 'col-cell flex' }, sortHeader('date', 'Изменён')),
    actions: h('span', { class: 'col-cell text-right' }, 'Действия'),
  };
  // Перестановка: заголовок тянется на место другого (кроме «Действий»).
  let draggingCol = null;
  for (const k of ['name', 'size', 'date']) {
    const cell = headCells[k];
    cell.draggable = true;
    cell.title = 'Перетащите, чтобы поменять столбцы местами';
    cell.addEventListener('dragstart', (e) => {
      draggingCol = k;
      e.dataTransfer.setData('text/x-fm-column', k);
      e.dataTransfer.effectAllowed = 'move';
      cell.classList.add('is-col-dragging');
    });
    cell.addEventListener('dragend', () => { draggingCol = null; cell.classList.remove('is-col-dragging'); });
    cell.addEventListener('dragover', (e) => {
      if (!draggingCol || draggingCol === k) return;
      e.preventDefault();
      cell.classList.add('is-col-drop');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('is-col-drop'));
    cell.addEventListener('drop', (e) => {
      cell.classList.remove('is-col-drop');
      if (!draggingCol || draggingCol === k) return;
      e.preventDefault();
      const from = order.indexOf(draggingCol);
      const to = order.indexOf(k);
      order = [...order];
      [order[from], order[to]] = [order[to], order[from]];
      renderHead();
      applyColumns();
    });
  }
  // Ручки ширины — на левой границе каждого столбца, кроме первого (по текущему порядку).
  function renderHead() {
    for (const cell of Object.values(headCells)) cell.querySelector(':scope > .col-resizer')?.remove();
    for (let i = 1; i < order.length; i++) headCells[order[i]].prepend(resizer(order[i - 1], order[i]));
  }
  const head = h('div', { class: 'list-head hidden items-center gap-4 border-b border-slate-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-400 md:grid dark:border-slate-800' },
    headCells.name, headCells.size, headCells.date, headCells.actions);
  renderHead();

  const dropzone = canEdit && h('div', { class: 'dropzone group hidden items-center sm:flex gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/60 px-4 py-3 text-sm dark:border-slate-700 dark:bg-slate-900/40' },
    h('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400' }, icon('upload')),
    h('p', { class: 'min-w-0 text-slate-600 dark:text-slate-300', title: 'Файлы и папки можно перетащить сюда или вставить из буфера (Ctrl+V)' },
      'Перетащите сюда или загрузите ',
      h('button', { type: 'button', class: 'link', onclick: () => ctx.pickFiles(folder) }, 'файлы'),
      ' · ',
      h('button', { type: 'button', class: 'link', onclick: () => ctx.pickFolder(folder) }, 'папку'),
      ' · ',
      h('button', { type: 'button', class: 'link', onclick: () => ctx.importFromUrl(folder) }, 'по ссылке')));

  const overlay = h('div', { class: 'drop-overlay pointer-events-none absolute inset-3 z-10 hidden items-center justify-center rounded-2xl border-2 border-dashed border-brand-500 bg-brand-50/90 backdrop-blur-sm dark:bg-brand-950/80' },
    h('div', { class: 'text-center' },
      h('span', { class: 'mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-brand-600 shadow dark:bg-slate-900' }, icon('upload', 'h-7 w-7')),
      h('p', { class: 'font-medium text-brand-800 dark:text-brand-200' }, 'Отпустите, чтобы загрузить'),
      h('p', { class: 'text-sm text-brand-700/80 dark:text-brand-300/80' }, `в «${crumbs.at(-1)[0]}»`)));

  // overflow-clip, а не hidden: не создаёт свою прокрутку, и шапка с панелью выбора
  // остаётся прилипшей к верху при прокрутке длинного списка.
  const card = h('section', { class: 'card overflow-clip' },
    h('div', { class: 'list-toolbar sticky top-0 z-20 flex min-h-[3.75rem] flex-col gap-3 rounded-t-2xl border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between dark:border-slate-800 dark:bg-slate-900/95' },
      h('div', { class: 'flex min-h-9 min-w-0 items-center' }, summary, bulkBar),
      toolbar),
    warnBox, head, list, empty, skeleton, loadMoreWrap);
  applyColumns(false);
  applyView();

  view.replaceChildren(h('div', { class: 'mx-auto max-w-6xl space-y-4 p-4 sm:p-6' }, dropzone, card), overlay);

  // ---------- элементы списка ----------
  const actionBtn = (name, label, onclick, danger, extra = '') => h('button', {
    type: 'button', class: `${danger ? 'icon-btn-danger' : 'icon-btn'} ${extra}`, title: label, 'aria-label': label, tabindex: '-1',
    onclick: (e) => { e.stopPropagation(); onclick(e.currentTarget); },
  }, danger || name === 'more' ? icon(name) : toned(name));

  const fileMenu = (file) => (btn) => openMenu(btn, [
    { label: 'Скачать', icon: 'download', onSelect: () => download(file) },
    canEdit && { label: 'Поделиться…', icon: 'globe', onSelect: () => openShareDialog({ file }) },
    canEdit && { label: 'Переименовать', icon: 'pencil', onSelect: () => renameFile(file) },
    canEdit && { label: 'Переместить…', icon: 'move', onSelect: () => moveFile(file) },
    { more: [
      { label: 'Скопировать ссылку', icon: 'link', onSelect: () => copyFileLink(file) },
      { label: state.checked.has(file.key) ? 'Снять выбор' : 'Выбрать', icon: 'check', onSelect: () => toggleChecked(file.key) },
      favoriteItem({ type: 'file', key: file.key, name: file.name, folder }),
      canEdit && { label: 'Копировать…', icon: 'copy', onSelect: () => copyFiles([file]) },
      canEdit && { label: 'Сделать копию', icon: 'copy', onSelect: () => copyFiles([file], folder) },
      canEdit && ctx.storages.length > 1 && { label: 'Перенести в хранилище…', icon: 'server', onSelect: () => transferFiles([file]) },
      canEdit && labelMenuItem(() => btn, { key: file.key }, file, () => renderList()),
      canEdit && { label: file.expiresAt ? 'Срок хранения (задан)…' : 'Срок хранения…', icon: 'clock', onSelect: () => setExpiry([file]) },
    ] },
    canEdit && { label: 'Удалить', icon: 'trash', danger: true, onSelect: () => deleteFile(file) },
  ]);

  const favoriteItem = (item) => {
    const fav = isFavorite(item);
    return { label: fav ? 'Убрать из избранного' : 'В избранное', icon: 'star', onSelect: () => {
      toast(toggleFavorite(item) ? `«${item.name}» в избранном` : `«${item.name}» убран из избранного`, 'success');
    } };
  };

  const folderMenu = (f) => (btn) => openMenu(btn, [
    { label: 'Открыть', icon: 'folder', onSelect: () => ctx.navigate(diskHash(f.path)) },
    { label: 'Скачать ZIP', icon: 'download', onSelect: () => downloadZip({ folder: f.path }) },
    canEdit && { label: 'Поделиться…', icon: 'globe', onSelect: () => openShareDialog({ folder: f.path }) },
    canEdit && { label: 'Переименовать', icon: 'pencil', onSelect: () => renameFolder(f) },
    canEdit && { label: 'Переместить…', icon: 'move', onSelect: () => moveFolder(f) },
    { more: [
      favoriteItem({ type: 'folder', path: f.path, name: f.name }),
      canEdit && labelMenuItem(() => btn, { folder: f.path }, f, () => renderList()),
      canEdit && { label: 'Цвет и значок…', icon: 'star', onSelect: () => styleFolder(f) },
      ctx.can('admin') && { label: 'Доступ…', icon: 'lock', onSelect: async () => { if (await openAclDialog(f.path)) load(); } },
    ] },
    canEdit && { label: 'Удалить папку', icon: 'trash', danger: true, onSelect: () => deleteFolder(f) },
  ]);

  // Срок хранения: сколько дней осталось до автоматического удаления в корзину.
  function expiryChip(file) {
    if (!file.expiresAt) return null;
    const days = Math.max(0, Math.ceil((Date.parse(file.expiresAt) - Date.now()) / 86_400_000));
    const title = `Удалится в корзину ${formatDate(file.expiresAt)}`;
    return h('span', {
      class: `inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums ${days <= 1
        ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'}`,
      title, 'aria-label': title,
    }, icon('clock', 'h-3 w-3'), days ? `${days} дн.` : 'сегодня');
  }

  const commentChip = (file) => file.comments && h('span', {
    class: 'inline-flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-slate-400', title: `Комментарии: ${file.comments}`, 'aria-label': `Комментарии: ${file.comments}`,
  }, icon('message', 'h-3 w-3'), String(file.comments));

  // Файл в публичном доступе (своя ссылка или ссылка на папку): значок и сколько раз скачали.
  function publicChip(file) {
    const p = file.public;
    if (!p) return null;
    const title = `${p.active ? 'Доступен по публичной ссылке' : 'Публичная ссылка больше не действует'} · скачиваний: ${p.downloads}`;
    return h('span', {
      class: `inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums ${p.active
        ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`,
      title, 'aria-label': title,
    }, icon('globe', 'h-3 w-3'), p.downloads ? String(p.downloads) : null);
  }

  // Личная папка — «личная»; папка со своими правами (видит администратор) — замок.
  function folderBadge(f) {
    if (f.personal) return h('span', { class: 'shrink-0 text-slate-400', title: f.personal === ctx.user.username ? 'Ваша личная папка' : `Личная папка ${f.personal}`, role: 'img', 'aria-label': 'Личная папка' }, icon('user', 'h-3.5 w-3.5'));
    if (f.restricted) return h('span', { class: 'shrink-0 text-amber-500', title: 'Доступ ограничен', role: 'img', 'aria-label': 'Доступ ограничен' }, icon('lock', 'h-3.5 w-3.5'));
    return null;
  }

  function folderItem(f) {
    const grid = state.layout === 'grid';
    const id = `dir:${f.path}`;
    const check = h('input', {
      type: 'checkbox', class: 'check', tabindex: '-1', checked: state.checkedFolders.has(f.path), 'aria-label': `Выбрать папку ${f.name}`,
      onclick: (e) => { e.stopPropagation(); toggleChecked(id, e.shiftKey); },
    });
    const li = h('li', {
      class: grid ? 'tile' : 'file-row', role: 'option', 'aria-selected': String(state.checkedFolders.has(f.path)), tabindex: '-1', dataset: { folder: f.path },
      draggable: canEdit ? 'true' : undefined,
      onclick: (e) => {
        // Как у файлов: Shift/Ctrl — выбор, в режиме выбора клик выбирает, иначе — открыть.
        if (e.shiftKey) return toggleChecked(id, true);
        if (e.ctrlKey || e.metaKey || selectedCount()) return toggleChecked(id);
        ctx.navigate(diskHash(f.path));
      },
      onkeydown: (e) => { if (e.target === e.currentTarget && e.key === 'Enter') ctx.navigate(diskHash(f.path)); },
      ondragstart: (e) => { // папку можно перетащить в другую папку (вместе с выбранными)
        const sel = state.checkedFolders.has(f.path) ? [...state.checkedFolders] : [f.path];
        e.dataTransfer.setData(FOLDER_DRAG, sel.join('\n'));
        if (state.checkedFolders.has(f.path) && state.checked.size) e.dataTransfer.setData(DRAG_TYPE, [...state.checked].join('\n'));
        e.dataTransfer.effectAllowed = 'move';
        li.classList.add('is-dragging');
      },
      ondragend: () => li.classList.remove('is-dragging'),
    },
    grid
      ? [h('span', { class: `tile-media ${folderTone(f)}` }, icon(folderIconName(f), 'h-10 w-10')),
        h('span', { class: 'tile-check' }, check),
        h('span', { class: 'tile-body' },
          h('span', { class: 'flex min-w-0 items-center gap-1.5' }, labelDot(f.label), h('span', { class: 'block truncate text-sm font-medium', title: f.name }, f.name), folderBadge(f)),
          h('span', { class: 'block text-xs text-slate-500 dark:text-slate-400' }, 'Папка')),
        h('span', { class: 'tile-actions' }, actionBtn('more', 'Действия с папкой', folderMenu(f)))]
      : [h('div', { class: 'flex min-w-0 items-center gap-3' },
        h('span', { class: 'check-cell' }, check),
        h('span', { class: `flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${folderTone(f)}` }, icon(folderIconName(f))),
        h('div', { class: 'min-w-0' },
          h('div', { class: 'flex min-w-0 items-center gap-2' }, h('p', { class: 'truncate text-sm font-medium', title: f.name }, f.name), labelDot(f.label), folderBadge(f)),
          h('p', { class: 'text-xs text-slate-500 md:hidden dark:text-slate-400' }, 'Папка'))),
      h('span', { class: 'hidden text-right text-sm text-slate-400 md:block' }, '—'),
      h('span', { class: 'hidden text-sm text-slate-500 md:block dark:text-slate-400' }, 'Папка'),
      h('div', { class: 'row-actions flex justify-end gap-0.5' },
        actionBtn('more', 'Действия с папкой', folderMenu(f)))]);
    if (canEdit) {
      makeDropTarget(li, (keys) => moveByKeys(keys, f.path));
      makeFolderDropTarget(li, f.path);
    }
    return li;
  }

  function fileItem(file) {
    const grid = state.layout === 'grid';
    const check = h('input', {
      type: 'checkbox', class: 'check', tabindex: '-1', checked: state.checked.has(file.key), 'aria-label': `Выбрать ${file.name}`,
      onclick: (e) => { e.stopPropagation(); toggleChecked(file.key, e.shiftKey); },
    });
    const li = h('li', {
      class: grid ? 'tile' : 'file-row', role: 'option', tabindex: '-1',
      'aria-selected': String(state.checked.has(file.key) || state.selected === file.key),
      dataset: { key: file.key },
      draggable: canEdit ? 'true' : undefined,
      onclick: (e) => {
        if (e.shiftKey) return toggleChecked(file.key, true);
        if (e.ctrlKey || e.metaKey) return toggleChecked(file.key);
        if (selectedCount()) return toggleChecked(file.key); // в режиме выбора клик выбирает
        select(file);
      },
      // Наведение — заранее берём ссылку на скачивание: её нужно отдать браузеру
      // сразу в начале перетаскивания (файл можно бросить на рабочий стол).
      onpointerenter: (e) => { if (e.pointerType === 'mouse') prefetchDragUrl(file); },
      ondragstart: (e) => {
        // Перетаскиваем все выбранные файлы, если тянем один из них.
        const keys = state.checked.has(file.key) ? [...state.checked] : [file.key];
        e.dataTransfer.setData(DRAG_TYPE, keys.join('\n'));
        e.dataTransfer.effectAllowed = 'copyMove';
        // Один файл — его можно вытащить из браузера на рабочий стол (Chrome, Edge, Яндекс Браузер).
        const link = keys.length === 1 && dragUrls.get(file.key);
        if (link && link.until > Date.now()) e.dataTransfer.setData('DownloadURL', `application/octet-stream:${file.name.replace(/:/g, '_')}:${link.url}`);
        li.classList.add('is-dragging');
      },
      ondragend: () => li.classList.remove('is-dragging'),
    },
    grid
      ? [h('span', { class: 'tile-media' }, thumbnail(file, { cls: 'h-full w-full', iconSize: 'h-9 w-9' })),
        h('span', { class: 'tile-check' }, check),
        h('span', { class: 'tile-body' },
          h('span', { class: 'flex min-w-0 items-center gap-1.5' }, labelDot(file.label), h('span', { class: 'block truncate text-sm font-medium', title: file.name }, file.name), publicChip(file)),
          h('span', { class: 'block truncate text-xs tabular-nums text-slate-500 dark:text-slate-400', title: formatDate(file.lastModified) },
            `${formatSize(file.size)} · ${formatDateShort(file.lastModified, { time: false })}`)),
        h('span', { class: 'tile-actions' }, actionBtn('more', 'Действия', fileMenu(file)))]
      : [h('div', { class: 'flex min-w-0 items-center gap-3' },
        h('span', { class: 'check-cell' }, check),
        thumbnail(file),
        h('div', { class: 'min-w-0' },
          h('div', { class: 'flex min-w-0 items-center gap-2' },
            h('p', { class: 'truncate text-sm font-medium', title: file.name }, file.name),
            labelDot(file.label),
            publicChip(file),
            expiryChip(file),
            commentChip(file),
            storageChip(file)),
          h('p', { class: 'truncate text-xs tabular-nums text-slate-500 md:hidden dark:text-slate-400' }, `${formatSize(file.size)} · ${formatDateShort(file.lastModified)}`))),
      h('span', { class: 'hidden text-right text-sm tabular-nums text-slate-500 md:block dark:text-slate-400' }, formatSize(file.size)),
      h('span', { class: 'hidden truncate text-sm text-slate-500 md:block dark:text-slate-400', title: formatDate(file.lastModified) }, formatDateShort(file.lastModified)),
      // На узких экранах — только меню «⋯» (в нём есть и «Скачать», и «Ссылка»).
      h('div', { class: 'row-actions flex justify-end gap-0.5' },
        actionBtn('download', 'Скачать', () => download(file), false, 'hidden md:inline-flex'),
        actionBtn('link', 'Скопировать ссылку для скачивания', () => copyFileLink(file), false, 'hidden md:inline-flex'),
        actionBtn('more', 'Ещё действия', fileMenu(file)))]);
    return li;
  }

  // ---------- отрисовка ----------
  function visible() {
    const match = (name) => !state.query || name.toLowerCase().includes(state.query);
    const { by, dir } = state.sort;
    const sign = dir === 'asc' ? 1 : -1;
    const folders = state.folders.filter((f) => match(f.name));
    if (by === 'name' && dir === 'desc') folders.reverse();
    let files = state.files.filter((f) => match(f.name)).sort((a, b) => sign * SORTS[by].cmp(a, b));
    if (state.group) { // группы по дате; порядок групп — как у даты, внутри группы — выбранная сортировка
      const rank = (f) => DATE_GROUPS.findIndex((g) => g.test(f.lastModified));
      const gsign = by === 'date' ? sign : -1;
      files = files.map((f, i) => [f, rank(f), i]).sort((a, b) => gsign * (b[1] - a[1]) || a[2] - b[2]).map(([f]) => f);
    }
    return { folders, files };
  }

  // Папки вперемешку с файлами: у папок нет даты и размера — по имени они встают на место,
  // по дате и размеру считаются «самыми старыми/маленькими».
  function mixedOrder(folders, files) {
    const { by, dir } = state.sort;
    const sign = dir === 'asc' ? 1 : -1;
    const asItem = (f) => ({ name: f.name, size: 0, lastModified: '', folder: f });
    return [...folders.map(asItem), ...files].sort((a, b) => sign * SORTS[by].cmp(a, b))
      .map((x) => (x.folder ? folderItem(x.folder) : fileItem(x)));
  }

  function groupedNodes(folders, files) {
    const out = folders.length ? [groupHead('Папки'), ...folders.map(folderItem)] : [];
    let current = -1;
    for (const f of files) {
      const g = DATE_GROUPS.findIndex((x) => x.test(f.lastModified));
      if (g !== current) { current = g; out.push(groupHead(DATE_GROUPS[g].label)); }
      out.push(fileItem(f));
    }
    return out;
  }
  const groupHead = (label) => h('div', { class: 'list-group-head', role: 'presentation' }, label);

  function renderList() {
    const { folders, files } = visible();
    const focusedKey = document.activeElement?.closest?.('#view [role=option]')?.dataset;
    list.className = state.layout === 'grid' ? 'file-grid' : 'file-list';
    head.classList.toggle('md:grid', state.layout === 'list');
    list.replaceChildren(...(state.group ? groupedNodes(folders, files)
      : state.mixed ? mixedOrder(folders, files)
        : [...folders.map(folderItem), ...files.map(fileItem)]));
    // Клавиатурный фокус переживает перерисовку (сортировку, выбор).
    const restore = focusedKey && list.querySelector(focusedKey.key ? `[data-key="${CSS.escape(focusedKey.key)}"]` : `[data-folder="${CSS.escape(focusedKey.folder ?? '')}"]`);
    setRoving(restore ?? list.firstElementChild);
    if (restore) restore.focus({ preventScroll: true });

    const total = state.files.reduce((s, f) => s + f.size, 0);
    const more = state.cursor ? '+' : '';
    const parts = [];
    if (state.folders.length) parts.push(pluralize(state.folders.length, FOLDERS));
    if (state.files.length || !parts.length) parts.push(`${pluralize(state.files.length, FILES)}${more}`);
    summary.textContent = state.loading && !state.files.length ? 'Загрузка…' : `${parts.join(', ')} · ${formatSize(total)}${more}`;

    for (const btn of head.querySelectorAll('.sort-head')) {
      const active = btn.dataset.sort === state.sort.by;
      btn.classList.toggle('is-active', active);
      btn.classList.toggle('is-asc', active && state.sort.dir === 'asc');
      btn.setAttribute('aria-sort', active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
    sortBtn.title = `Сортировка: ${SORTS[state.sort.by].label.toLowerCase()}`;
    sortBtn.setAttribute('aria-label', sortBtn.title);

    const isEmpty = !state.loading && !folders.length && !files.length;
    empty.classList.toggle('hidden', !isEmpty);
    if (isEmpty) {
      empty.replaceChildren(
        h('span', { class: 'mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800' }, icon(state.query ? 'search' : 'folder', 'h-6 w-6')),
        h('p', { class: 'font-medium' }, state.query ? 'Ничего не найдено' : 'Папка пуста'),
        h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' },
          state.query ? 'Попробуйте изменить запрос.' : canEdit ? 'Перетащите сюда файлы или папки, вставьте скриншот (Ctrl+V) или нажмите «Загрузить».' : 'Здесь пока нет файлов.'),
        state.query && h('div', { class: 'mt-5 flex justify-center' },
          h('a', { class: 'btn-ghost', href: searchHash({ q: search.value.trim() }) }, icon('search'), 'Искать по всему диску')),
        canEdit && !state.query && h('div', { class: 'mt-5 flex justify-center gap-2' },
          h('button', { type: 'button', class: 'btn-primary', onclick: () => ctx.pickFiles(folder) }, icon('upload'), 'Загрузить файлы'),
          h('button', { type: 'button', class: 'btn-ghost', onclick: () => ctx.pickFolder(folder) }, icon('folderUp'), 'Папку')));
    }
    loadMoreWrap.classList.toggle('hidden', !state.cursor);
    renderBulk();
  }

  // ---------- выбор: файлы и папки ----------
  // id элемента: ключ файла или «dir:<путь>» для папки.
  const idOf = (li) => (li.dataset.key ?? `dir:${li.dataset.folder}`);
  const isChecked = (id) => (id.startsWith('dir:') ? state.checkedFolders.has(id.slice(4)) : state.checked.has(id));
  function setChecked(id, on) {
    const set = id.startsWith('dir:') ? state.checkedFolders : state.checked;
    const v = id.startsWith('dir:') ? id.slice(4) : id;
    if (on) set.add(v); else set.delete(v);
  }
  const selectedCount = () => state.checked.size + state.checkedFolders.size;
  const checkedFolders = () => state.folders.filter((f) => state.checkedFolders.has(f.path));
  const selectionForZip = () => ({ keys: [...state.checked], folders: [...state.checkedFolders] });

  function renderBulk() {
    // Выбор мог включать файлы и папки, которых уже нет (удалены, перемещены).
    for (const key of state.checked) if (!state.files.some((f) => f.key === key)) state.checked.delete(key);
    for (const p of state.checkedFolders) if (!state.folders.some((f) => f.path === p)) state.checkedFolders.delete(p);
    const n = selectedCount();
    bulkBar.classList.toggle('hidden', !n);
    bulkBar.classList.toggle('flex', n > 0);
    summary.classList.toggle('hidden', n > 0);
    bulkCount.textContent = `Выбрано: ${n}`;
    bulkCount.title = [state.checkedFolders.size && pluralize(state.checkedFolders.size, FOLDERS), state.checked.size && pluralize(state.checked.size, FILES)].filter(Boolean).join(', ');
    // Ссылки и перенос между хранилищами — только для файлов.
    for (const b of bulkBar.querySelectorAll('.files-only')) b.classList.toggle('hidden', !state.checked.size);
    card.classList.toggle('has-selection', n > 0);
    const all = items();
    checkAll.checked = n > 0 && all.every((li) => isChecked(idOf(li)));
    checkAll.indeterminate = n > 0 && !checkAll.checked;
  }

  function markSelection() {
    const cut = clip.data?.mode === 'cut' && clip.data.from === folder
      ? new Set([...clip.data.files.map((f) => f.key), ...clip.data.folders.map((f) => `dir:${f.path}`)]) : null;
    for (const li of list.querySelectorAll('[role=option]')) {
      const id = idOf(li);
      li.setAttribute('aria-selected', String(isChecked(id) || state.selected === id));
      li.classList.toggle('is-cut', Boolean(cut?.has(id)));
      const box = li.querySelector('.check');
      if (box) box.checked = isChecked(id);
    }
    renderBulk();
  }

  function toggleChecked(id, range = false) {
    if (range && state.anchor) {
      const ids = items().map(idOf);
      const a = ids.indexOf(state.anchor);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) setChecked(ids[i], true);
        return markSelection();
      }
    }
    setChecked(id, !isChecked(id));
    state.anchor = id;
    markSelection();
  }
  function checkAllFiles() { // Ctrl+A и «выбрать всё» — и файлы, и папки
    for (const li of items()) setChecked(idOf(li), true);
    markSelection();
  }
  function clearChecked() {
    state.checked.clear();
    state.checkedFolders.clear();
    state.anchor = null;
    markSelection();
  }

  function select(file) {
    rememberOpened(file, folder);
    state.selected = file.key;
    markSelection();
    // Открытый файл — в адресе: ссылку можно переслать (откроется эта папка и этот файл).
    history.replaceState(null, '', diskHash(folder, file.key));
    // Галерея листает изображения папки в текущем порядке сортировки.
    const gallery = () => visible().files.filter((f) => categoryOf(f.name) === 'image');
    const siblings = () => state.files;
    showPreview(file, canEdit
      ? { folder, gallery, siblings, onDelete: deleteFile, onRename: renameFile, onMove: moveFile }
      : { folder, gallery, siblings });
  }

  // ---------- вид и сортировка ----------
  function setLayout(layout) {
    if (state.layout === layout) return;
    state.layout = layout;
    prefs.set('layout', layout);
    for (const b of layoutBtns) b.setAttribute('aria-pressed', String(b === layoutBtns[layout === 'list' ? 0 : 1]));
    list.classList.add('is-switching');
    renderList();
    setTimeout(() => list.classList.remove('is-switching'), 300);
  }

  function setSort(by, dir) {
    const same = state.sort.by === by;
    state.sort = { by, dir: dir ?? (same ? (state.sort.dir === 'asc' ? 'desc' : 'asc') : DEFAULT_DIR[by]) };
    prefs.set('sort', `${state.sort.by}-${state.sort.dir}`);
    renderList();
  }

  function openSortMenu(anchor) {
    const mark = (by, dir) => (state.sort.by === by && state.sort.dir === dir ? 'check' : 'sort');
    openMenu(anchor, [
      { label: 'Сначала новые', icon: mark('date', 'desc'), onSelect: () => setSort('date', 'desc') },
      { label: 'Сначала старые', icon: mark('date', 'asc'), onSelect: () => setSort('date', 'asc') },
      { label: 'По имени, А → Я', icon: mark('name', 'asc'), onSelect: () => setSort('name', 'asc') },
      { label: 'По имени, Я → А', icon: mark('name', 'desc'), onSelect: () => setSort('name', 'desc') },
      { label: 'Сначала большие', icon: mark('size', 'desc'), onSelect: () => setSort('size', 'desc') },
      { label: 'Сначала маленькие', icon: mark('size', 'asc'), onSelect: () => setSort('size', 'asc') },
      { label: 'Папки вперемешку с файлами', icon: state.mixed ? 'check' : 'folder', onSelect: () => setView('mixed', !state.mixed) },
      { label: 'Группировать по дате', icon: state.group ? 'check' : 'calendar', onSelect: () => setView('group', !state.group) },
      { more: [ // вид: плотность списка и размер плиток
        { label: 'Список: обычный', icon: density === 'normal' ? 'check' : 'list', onSelect: () => setDensity('normal') },
        { label: 'Список: компактный', icon: density === 'compact' ? 'check' : 'list', onSelect: () => setDensity('compact') },
        { label: 'Плитки: маленькие', icon: tileSize === 's' ? 'check' : 'grid', onSelect: () => setTileSize('s') },
        { label: 'Плитки: средние', icon: tileSize === 'm' ? 'check' : 'grid', onSelect: () => setTileSize('m') },
        { label: 'Плитки: большие', icon: tileSize === 'l' ? 'check' : 'grid', onSelect: () => setTileSize('l') },
      ], label: 'Вид…', icon: 'eye' },
    ]);
  }

  // Плотность списка и размер плиток — запоминаются (значения — выше, у state).
  function applyView() {
    card.classList.toggle('density-compact', density === 'compact');
    card.style.setProperty('--tile-min', { s: '7.5rem', m: '9.5rem', l: '13rem' }[tileSize]);
  }
  function setDensity(v) { density = v; prefs.set('density', v); applyView(); if (state.layout !== 'list') setLayout('list'); }
  function setTileSize(v) { tileSize = v; prefs.set('tile-size', v); applyView(); if (state.layout !== 'grid') setLayout('grid'); }

  function setView(key, value) {
    state[key] = value;
    prefs.set(key === 'mixed' ? 'mixed' : 'group-date', value ? '1' : '0');
    renderList();
  }

  // ---------- клавиатура ----------
  // Один элемент списка в порядке Tab (roving tabindex), стрелки двигают фокус.
  function setRoving(el) {
    for (const item of list.querySelectorAll('[role=option][tabindex="0"]')) item.tabIndex = -1;
    if (el) el.tabIndex = 0;
  }
  const items = () => [...list.querySelectorAll('[role=option]')];
  function columns() {
    if (state.layout !== 'grid') return 1;
    const all = items();
    const top = all[0]?.offsetTop;
    return Math.max(1, all.filter((el) => el.offsetTop === top).length);
  }
  function focusAt(i) {
    const all = items();
    const el = all[Math.max(0, Math.min(all.length - 1, i))];
    if (!el) return;
    setRoving(el);
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
  }
  on(list, 'keydown', (e) => {
    const all = items();
    const i = all.indexOf(e.target);
    if (i < 0) return;
    const key = e.target.dataset.key;
    const file = key && state.files.find((f) => f.key === key);
    const step = { ArrowDown: columns(), ArrowUp: -columns(), ArrowRight: state.layout === 'grid' ? 1 : 0, ArrowLeft: state.layout === 'grid' ? -1 : 0 }[e.key];
    if (step) {
      e.preventDefault();
      focusAt(i + step);
      if (e.shiftKey) {
        const next = items()[Math.max(0, Math.min(all.length - 1, i + step))];
        if (next) { setChecked(idOf(e.target), true); setChecked(idOf(next), true); state.anchor = idOf(next); markSelection(); }
      }
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusAt(e.key === 'Home' ? 0 : all.length - 1);
    } else if (file && (e.key === 'Enter' || (e.key === ' ' && !selectedCount()))) {
      e.preventDefault();
      select(file);
    } else if (e.key === ' ') {
      e.preventDefault();
      toggleChecked(idOf(e.target));
    } else if (canEdit && e.key === 'Delete') {
      e.preventDefault();
      if (selectedCount()) bulkDelete();
      else if (file) deleteFile(file);
      else if (e.target.dataset.folder) { const f = state.folders.find((x) => x.path === e.target.dataset.folder); if (f) deleteFolder(f); }
    } else if (canEdit && e.key === 'F2') {
      e.preventDefault();
      if (file) renameFile(file);
      else if (e.target.dataset.folder) { const f = state.folders.find((x) => x.path === e.target.dataset.folder); if (f) renameFolder(f); }
    }
  });
  on(list, 'focusin', (e) => { if (e.target.matches?.('[role=option]')) setRoving(e.target); });

  // ---------- контекстное меню (правый клик) ----------
  const atPointer = (e) => ({
    getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }),
    setAttribute() {}, focus() {},
  });
  on(view, 'contextmenu', (e) => {
    if (e.target.closest('input, textarea, a[href]:not([role=option])')) return;
    const item = e.target.closest('[role=option]');
    if (item?.dataset.key) {
      const file = state.files.find((f) => f.key === item.dataset.key);
      if (!file) return;
      e.preventDefault();
      // Правый клик по невыбранному файлу при наличии выбора — действует на него одного.
      if (selectedCount() > 1 && state.checked.has(file.key)) return openMenu(atPointer(e), bulkMenuItems());
      return fileMenu(file)(atPointer(e));
    }
    if (item?.dataset.folder !== undefined) {
      const f = state.folders.find((x) => x.path === item.dataset.folder);
      if (!f) return;
      e.preventDefault();
      if (selectedCount() > 1 && state.checkedFolders.has(f.path)) return openMenu(atPointer(e), bulkMenuItems());
      folderMenu(f)(atPointer(e));
      return;
    }
    if (!canEdit && !state.files.length && !state.folders.length) return;
    e.preventDefault();
    if (!canEdit) return openMenu(atPointer(e), [{ label: 'Скачать папку ZIP', icon: 'download', onSelect: () => downloadZip({ folder }) }]);
    openMenu(atPointer(e), [
      { label: 'Загрузить файлы', icon: 'upload', onSelect: () => ctx.pickFiles(folder) },
      { label: 'Загрузить папку', icon: 'folderUp', onSelect: () => ctx.pickFolder(folder) },
      { label: 'Загрузить по ссылке…', icon: 'globe', onSelect: () => ctx.importFromUrl(folder) },
      { label: 'Новая папка', icon: 'folderPlus', onSelect: newFolder },
      clip.data && { label: `Вставить (${clip.data.files.length + clip.data.folders.length})`, icon: 'clipboard', onSelect: pasteClip },
      (state.files.length || state.folders.length) && { label: 'Выбрать всё', icon: 'check', onSelect: checkAllFiles },
      { label: 'Скачать папку ZIP', icon: 'download', onSelect: () => downloadZip({ folder }) },
    ]);
  });

  // ---------- выделение рамкой (мышью по пустому месту) ----------
  on(view, 'pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType !== 'mouse') return;
    if (e.target.closest('[role=option], button, a, input, label, select, textarea, .dropzone, .bulk-bar, .list-head')) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const base = additive ? new Set([...state.checked, ...[...state.checkedFolders].map((p) => `dir:${p}`)]) : new Set();
    const start = { x: e.clientX, y: e.clientY };
    let band = null;
    e.preventDefault(); // без выделения текста при протягивании
    const move = (ev) => {
      if (!band && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      if (!band) { band = h('div', { class: 'select-band', 'aria-hidden': 'true' }); document.body.append(band); }
      const x1 = Math.min(start.x, ev.clientX); const x2 = Math.max(start.x, ev.clientX);
      const y1 = Math.min(start.y, ev.clientY); const y2 = Math.max(start.y, ev.clientY);
      Object.assign(band.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
      state.checked.clear();
      state.checkedFolders.clear();
      for (const id of base) setChecked(id, true);
      for (const li of items()) { // и файлы, и папки
        const r = li.getBoundingClientRect();
        if (r.right > x1 && r.left < x2 && r.bottom > y1 && r.top < y2) setChecked(idOf(li), true);
      }
      markSelection();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (band) band.remove();
      else if (!additive && selectedCount()) clearChecked(); // клик по пустому месту снимает выбор
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  on(document, 'keydown', (e) => {
    if (document.querySelector('dialog[open]') || isTyping(document.activeElement)) {
      if (e.key === 'Escape' && document.activeElement === search && search.value) { search.value = ''; state.query = ''; renderList(); }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === '/' && !mod) { e.preventDefault(); search.focus(); search.select(); }
    else if (e.key === '?') { e.preventDefault(); showShortcuts(); }
    else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); checkAllFiles(); }
    else if (canEdit && e.key === 'Delete' && !e.defaultPrevented && selectedCount()) { e.preventDefault(); bulkDelete(); }
    else if (e.key === 'Escape' && (selectedCount() || clip.data)) { clearChecked(); clip.data = null; markSelection(); }
    else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); }
    else if (mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x') && !window.getSelection()?.toString()) {
      if (toClipboard(e.key.toLowerCase() === 'x' ? 'cut' : 'copy')) e.preventDefault();
    } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { // на уровень выше
      if (folder !== homeFolder) { e.preventDefault(); ctx.navigate(diskHash(tree.parentOf(folder))); }
    } else if (canEdit && e.key === 'F7') { e.preventDefault(); newFolder(); }
  });

  function showShortcuts() {
    const row = (keys, text) => h('div', { class: 'flex items-center justify-between gap-4 py-1.5' },
      h('span', { class: 'text-sm text-slate-600 dark:text-slate-300' }, text),
      h('span', { class: 'flex shrink-0 gap-1' }, keys.map((k) => h('kbd', { class: 'kbd' }, k))));
    const close = h('button', { type: 'button', class: 'btn-primary', onclick: () => dialog.close() }, 'Понятно');
    const dialog = h('dialog', { class: 'w-[min(30rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200', 'aria-labelledby': 'kb-title' },
      h('div', { class: 'space-y-4 p-6' },
        h('h3', { id: 'kb-title', class: 'flex items-center gap-2 text-lg font-semibold' }, icon('keyboard', 'h-5 w-5 text-slate-400'), 'Горячие клавиши'),
        h('div', { class: 'divide-y divide-slate-100 dark:divide-slate-800' },
          row(['↑', '↓', '←', '→'], 'Перемещение по файлам'),
          row(['Enter'], 'Открыть файл или папку'),
          row(['Пробел'], 'Предпросмотр / выбрать в режиме выбора'),
          row(['Ctrl', 'клик'], 'Выбрать несколько файлов и папок'),
          row(['Shift', 'клик'], 'Выбрать диапазон'),
          row(['Ctrl', 'A'], 'Выбрать всё в папке'),
          row(['Esc'], 'Снять выбор'),
          row(['Ctrl', 'C'], 'Копировать выбранное'),
          canEdit && row(['Ctrl', 'X'], 'Вырезать выбранное'),
          canEdit && row(['Ctrl', 'V'], 'Вставить сюда (или загрузить картинку из буфера)'),
          canEdit && row(['Ctrl', 'Z'], 'Отменить последнее действие'),
          canEdit && row(['F2'], 'Переименовать'),
          canEdit && row(['F7'], 'Новая папка'),
          canEdit && row(['Delete'], 'Удалить'),
          row(['Backspace'], 'На уровень выше'),
          row(['/'], 'Поиск в папке'),
          row(['?'], 'Эта подсказка')),
        h('div', { class: 'flex justify-end' }, close)));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  }

  // ---------- данные ----------
  let loadSeq = 0;
  async function load({ append = false } = {}) {
    const seq = ++loadSeq;
    state.loading = true;
    loadMore.disabled = true;
    try {
      const res = await api.listFolder(folder, append ? state.cursor : undefined);
      if (seq !== loadSeq) return;
      state.files = append ? state.files.concat(res.files) : res.files;
      state.folders = append ? mergeFolders(state.folders, res.folders) : res.folders;
      state.cursor = res.nextCursor;
      if (!append) showWarnings(res.warnings);
      tree.setChildren(folder, state.folders);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (seq === loadSeq) {
        state.loading = false;
        loadMore.disabled = false;
        skeleton.remove();
        renderList();
      }
    }
    if (!append && !state.selected && selectId) {
      state.selected = state.files.find((f) => fileShortId(f.key) === selectId)?.key ?? null;
      selectId = null;
    }
    if (!append && state.selected) {
      const file = state.files.find((f) => f.key === state.selected);
      if (file && !isPreviewing(file.key)) select(file);
    }
  }
  const mergeFolders = (a, b) => [...new Map([...a, ...b].map((f) => [f.path, f])).values()];

  // Тихое обновление: файлы и папки, добавленные другими (или с другого устройства), появляются
  // без перезагрузки страницы. Выбор, прокрутка и открытый предпросмотр сохраняются.
  const sig = (files, folders) => `${folders.map((f) => `${f.path}|${f.label ?? ''}`).join(',')}#${files.map((f) => `${f.key}|${f.size}|${f.label ?? ''}`).join(',')}`;
  async function refresh() {
    if (state.loading || unmounted || document.querySelector('dialog[open]')) return;
    const seq = loadSeq;
    let res;
    try {
      res = await api.listFolder(folder);
    } catch {
      return;
    }
    if (seq !== loadSeq || unmounted) return;
    const n = res.files.length;
    const head = state.files.slice(0, n);
    if (sig(head, state.folders) === sig(res.files, res.folders)) return;
    // Догруженные «Показать ещё» страницы оставляем как есть.
    const tail = state.cursor || state.files.length > n ? state.files.slice(n).filter((f) => !res.files.some((x) => x.key === f.key)) : [];
    const present = new Set([...res.files, ...tail].map((f) => f.key));
    state.files = [...res.files, ...tail];
    state.folders = res.folders;
    if (!tail.length) state.cursor = res.nextCursor;
    for (const key of [...state.checked]) if (!present.has(key)) state.checked.delete(key);
    tree.setChildren(folder, state.folders);
    renderList();
  }
  const refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20_000);
  cleanup.push(() => clearInterval(refreshTimer));

  // ---------- действия с одним файлом ----------
  async function download(file) {
    try {
      const { url } = await api.downloadLink(file.key, 3600);
      window.location.assign(url);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function removeFiles(keys) {
    const gone = new Set(keys);
    state.files = state.files.filter((f) => !gone.has(f.key));
    for (const key of keys) { state.checked.delete(key); forgetThumb(key); }
    removeFromLibrary(keys);
    if (gone.has(state.selected)) closePreview();
  }

  // «…будет перемещён в корзину на 30 дней.» или «…будет удалён без возможности восстановления.»
  function trashNote(moved, deleted) {
    return ctx.trashDays
      ? `${moved} в корзину — восстановить можно в течение ${pluralize(ctx.trashDays, { one: 'дня', few: 'дней', many: 'дней', other: 'дня' })}.`
      : `${deleted} без возможности восстановления.`;
  }

  // Кнопка «Отменить» в уведомлении: вернуть только что удалённое из корзины.
  function undoAction(...ids) {
    if (!ids.filter(Boolean).length) return {};
    return { action: { label: 'Отменить', onClick: async () => {
      try {
        for (const id of ids.filter(Boolean)) await api.restoreTrash(id);
        toast('Восстановлено', 'success');
        ctx.refreshStats();
        if (!unmounted) load();
      } catch (err) {
        toast(err.message, 'error');
      }
    } } };
  }

  async function deleteFile(file) {
    if (!(await confirmDialog('Удалить файл?', `«${file.name}» ${trashNote('будет перемещён', 'будет удалён')} Выданные ссылки перестанут работать.`))) return;
    try {
      const { trashId } = await api.deleteFile(file.key);
      removeFiles([file.key]);
      renderList();
      ctx.refreshStats();
      if (trashId) pushUndo(`удаление «${file.name}»`, () => api.restoreTrash(trashId));
      toast(trashId ? 'Файл перемещён в корзину' : 'Файл удалён', 'success', undoAction(trashId));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Применяет результат переименования/перемещения к списку и панели предпросмотра.
  function applyMoved(oldKey, file, targetFolder) {
    const wasSelected = state.selected === oldKey;
    const wasChecked = state.checked.delete(oldKey);
    forgetThumb(oldKey);
    renameInLibrary(oldKey, file, targetFolder);
    if (targetFolder === folder) {
      state.files = state.files.map((f) => (f.key === oldKey ? file : f));
      if (wasChecked) state.checked.add(file.key);
      if (wasSelected) select(file);
    } else {
      state.files = state.files.filter((f) => f.key !== oldKey);
      if (wasSelected) closePreview();
    }
  }

  async function renameFile(file) {
    const dot = file.name.lastIndexOf('.');
    await openDialog({
      title: 'Переименовать файл',
      text: 'Ссылки на скачивание, выданные раньше, перестанут работать.',
      confirmLabel: 'Переименовать',
      fields: [{ name: 'name', label: 'Новое имя', value: file.name, maxlength: 180,
        select: [0, dot > 0 ? dot : file.name.length] }],
      async onSubmit({ name }) {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Введите имя файла');
        if (trimmed === file.name) return {};
        const res = await api.moveFile(file.key, { name: trimmed });
        applyMoved(file.key, res.file, res.folder);
        pushUndo(`переименование «${file.name}»`, () => api.moveFile(res.file.key, { name: file.name }));
        renderList();
        ctx.refreshStats();
        toast(`Переименовано в «${res.file.name}»`, 'success');
        return res;
      },
    });
  }

  async function moveFile(file) {
    const target = await pickFolder({ title: `Переместить «${file.name}»`, current: folder });
    if (target !== null) await moveFiles([file], target);
  }

  // ---------- действия с несколькими файлами ----------
  // Выполняет action для каждого файла, не более 4 одновременно; возвращает число ошибок.
  async function eachLimited(files, action) {
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++];
        try { await action(file); } catch (err) { failed++; if (failed === 1) toast(`${file.name}: ${err.message}`, 'error'); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
    return failed;
  }

  const checkedFiles = () => state.files.filter((f) => state.checked.has(f.key));

  async function moveFiles(files, target) {
    if (target === folder || !files.length) return;
    const moved = [];
    const from = folder;
    const failed = await eachLimited(files, async (file) => {
      const res = await api.moveFile(file.key, { folder: target });
      applyMoved(file.key, res.file, res.folder);
      moved.push(res.file.key);
    });
    if (moved.length) pushUndo(`перемещение ${pluralize(moved.length, FILES)}`, async () => { for (const k of moved) await api.moveFile(k, { folder: from }); });
    renderList();
    ctx.refreshStats();
    const ok = files.length - failed;
    if (ok) toast(files.length === 1 ? `«${files[0].name}» перемещён в «${folderLabel(target)}»` : `Перемещено ${pluralize(ok, FILES)} в «${folderLabel(target)}»`, 'success');
    if (failed) load();
  }

  // Копии файлов: target не задан — спросить папку; та же папка — «имя (копия).ext».
  async function copyFiles(files, target) {
    if (!files.length) return;
    if (target === undefined) {
      target = await pickFolder({ title: files.length === 1 ? `Копировать «${files[0].name}»` : `Копировать ${pluralize(files.length, FILES)}`, current: folder, allowCurrent: true, confirmLabel: 'Копировать сюда' });
      if (target === null) return;
    }
    const copied = [];
    const failed = await eachLimited(files, async (file) => {
      const res = await api.copyFile(file.key, { folder: target });
      copied.push(res.file);
    });
    if (copied.length) pushUndo(`копирование ${pluralize(copied.length, FILES)}`, () => api.deleteFiles(copied.map((f) => f.key)));
    if (target === folder) {
      for (const file of copied) if (!state.files.some((f) => f.key === file.key)) state.files.unshift(file);
    }
    renderList();
    ctx.refreshStats();
    if (copied.length) {
      toast(target === folder && copied.length === 1 ? `Создана «${copied[0].name}»`
        : `Скопировано ${pluralize(copied.length, FILES)} в «${folderLabel(target)}»`, 'success');
    }
    if (failed) load();
  }

  // ---------- перенос между хранилищами ----------
  function pickStorage(files) {
    return new Promise((resolve) => {
      const from = new Set(files.map((f) => f.storage));
      let chosen = null;
      const options = ctx.storages.map((st) => {
        const only = from.size === 1 && from.has(st.id);
        const input = h('input', { type: 'radio', name: 'target-storage', value: st.id, class: 'check', disabled: only,
          onchange: () => { chosen = st; ok.disabled = false; } });
        return h('label', { class: `flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm dark:border-slate-700 ${only ? 'opacity-50' : 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800'}` },
          input, icon('server', 'h-4 w-4 text-slate-400'), h('span', { class: 'flex-1' }, st.name), only && h('span', { class: 'text-xs text-slate-500' }, 'сейчас здесь'));
      });
      const ok = h('button', { type: 'button', class: 'btn-primary', disabled: true, onclick: () => { dialog.close(); resolve(chosen); } }, 'Перенести');
      const dialog = h('dialog', { class: 'w-[min(28rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' },
        h('div', { class: 'space-y-4 p-6' },
          h('h3', { class: 'text-lg font-semibold' }, files.length === 1 ? `Перенести «${files[0].name}»` : `Перенести ${pluralize(files.length, FILES)}`),
          h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' },
            'Файл останется в той же папке диска, но физически переедет в другой бакет. Сервер скачает его и загрузит заново — это займёт время и трафик VDS. Ссылки, выданные раньше, перестанут работать.'),
          h('div', { class: 'space-y-2', role: 'radiogroup', 'aria-label': 'Хранилище' }, options),
          h('div', { class: 'flex justify-end gap-2' },
            h('button', { type: 'button', class: 'btn-ghost', onclick: () => dialog.close() }, 'Отмена'), ok)));
      dialog.addEventListener('close', () => { dialog.remove(); resolve(null); });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  // Файлы переносятся по одному (сервер одновременно ведёт не больше двух переносов).
  async function transferFiles(files) {
    const target = await pickStorage(files);
    if (!target) return;
    let moved = 0;
    for (const file of files.filter((f) => f.storage !== target.id)) {
      try {
        const job = await ctx.transferFile(file, target);
        if (job?.status === 'done') moved++;
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    if (moved) toast(`Перенесено в «${target.name}»: ${pluralize(moved, FILES)}`, 'success');
  }

  // Цель перетаскивания: папка в списке, в дереве или в хлебных крошках.
  function moveByKeys(keys, target) {
    const set = new Set(String(keys).split('\n'));
    moveFiles(state.files.filter((f) => set.has(f.key)), target);
  }

  async function bulkMove() {
    const files = checkedFiles();
    const target = await pickFolder({ title: `Переместить ${pluralize(files.length, FILES)}`, current: folder });
    if (target !== null) await moveFiles(files, target);
  }

  async function bulkDelete() {
    const files = checkedFiles();
    const folders = checkedFolders();
    if (!files.length && !folders.length) return;
    if (!(await confirmDialog(`Удалить ${selectionLabel(files, folders)}?`, `${folders.length ? 'Папки со всем содержимым и файлы' : 'Файлы'} ${trashNote('будут перемещены', 'будут удалены')} Выданные ссылки перестанут работать.`))) return;
    const done = [];
    const trashIds = [];
    let failed = 0;
    let foldersGone = 0;
    for (const f of folders) {
      try {
        const r = await api.deleteFolder(f.path);
        if (r.trashId) trashIds.push(r.trashId);
        tree.forget(f.path);
        forgetFolder(f.path);
        foldersGone++;
      } catch (err) { toast(`${f.name}: ${err.message}`, 'error'); }
    }
    if (foldersGone) {
      state.folders = state.folders.filter((x) => !state.checkedFolders.has(x.path));
      tree.setChildren(folder, state.folders);
    }
    for (let i = 0; i < files.length; i += 500) {
      try {
        const r = await api.deleteFiles(files.slice(i, i + 500).map((f) => f.key));
        done.push(...r.deleted);
        if (r.trashId) trashIds.push(r.trashId);
        failed += r.failed;
      } catch (err) {
        failed += Math.min(500, files.length - i);
        toast(err.message, 'error');
      }
    }
    removeFiles(done);
    renderList();
    ctx.refreshStats();
    if (trashIds.length) pushUndo('удаление', async () => { for (const id of trashIds) await api.restoreTrash(id); });
    if (done.length || foldersGone) {
      toast(`${trashIds.length ? 'В корзине' : 'Удалено'}: ${[foldersGone && pluralize(foldersGone, FOLDERS), done.length && pluralize(done.length, FILES)].filter(Boolean).join(' и ')}`, 'success', undoAction(...trashIds));
    }
    if (failed) { toast(`Не удалось удалить: ${pluralize(failed, FILES)}`, 'error'); load(); }
  }

  // ---------- цвет и значок папки ----------
  function styleFolder(f) {
    let color = f.style?.color ?? 'green';
    let ic = folderIconName(f);
    const preview = h('span', { class: 'flex h-14 w-14 items-center justify-center rounded-2xl' });
    const paint = () => {
      preview.className = `flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${FOLDER_TONES[color][0]}`;
      preview.replaceChildren(icon(ic, 'h-7 w-7'));
      for (const b of swatches) b.setAttribute('aria-pressed', String(b.dataset.v === color));
      for (const b of icons) b.setAttribute('aria-pressed', String(b.dataset.v === ic));
    };
    const swatches = Object.keys(FOLDER_TONES).map((c) => h('button', {
      type: 'button', dataset: { v: c }, 'aria-label': c, class: `h-8 w-8 rounded-full ring-offset-2 ${FOLDER_TONES[c][2]} aria-pressed:ring-2 aria-pressed:ring-brand-500 dark:ring-offset-slate-900`,
      onclick: () => { color = c; paint(); },
    }));
    const icons = FOLDER_ICONS.map((n) => h('button', {
      type: 'button', dataset: { v: n }, 'aria-label': n, class: 'flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 aria-pressed:bg-brand-50 aria-pressed:text-brand-700 aria-pressed:ring-2 aria-pressed:ring-brand-500 dark:text-slate-300 dark:hover:bg-slate-800 dark:aria-pressed:bg-brand-950/60',
      onclick: () => { ic = n; paint(); },
    }, icon(n, 'h-5 w-5')));
    const save = h('button', { type: 'button', class: 'btn-primary', onclick: async () => {
      try {
        const { style } = await api.folderStyle(f.path, { color: color === 'green' ? null : color, icon: ic === 'folder' ? null : ic });
        f.style = style ?? undefined;
        dialog.close();
        renderList();
        tree.reload(folder);
      } catch (err) { toast(err.message, 'error'); }
    } }, 'Сохранить');
    const dialog = h('dialog', { class: 'w-[min(26rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' },
      h('div', { class: 'space-y-5 p-6' },
        h('div', { class: 'flex items-center gap-4' }, preview, h('h3', { class: 'min-w-0 truncate text-lg font-semibold' }, f.name)),
        h('div', { class: 'space-y-2' }, h('p', { class: 'text-sm font-medium' }, 'Цвет'), h('div', { class: 'flex flex-wrap gap-2.5 p-1' }, swatches)),
        h('div', { class: 'space-y-2' }, h('p', { class: 'text-sm font-medium' }, 'Значок'), h('div', { class: 'grid grid-cols-6 gap-1.5' }, icons)),
        h('div', { class: 'flex justify-between gap-2' },
          h('button', { type: 'button', class: 'btn-ghost', onclick: () => { color = 'green'; ic = 'folder'; paint(); } }, 'Как обычно'),
          h('div', { class: 'flex gap-2' }, h('button', { type: 'button', class: 'btn-ghost', onclick: () => dialog.close() }, 'Отмена'), save))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    paint();
    dialog.showModal();
  }

  // ---------- действия над выбранными файлами и папками ----------
  function bulkMenuItems() {
    const n = selectedCount();
    const files = state.checked.size;
    return [
      { label: `Скачать ZIP (${n})`, icon: 'download', onSelect: () => downloadZip(selectionForZip()) },
      files && { label: `Скопировать ссылки (${files})`, icon: 'link', onSelect: bulkCopyLinks },
      canEdit && { label: 'Переместить…', icon: 'move', onSelect: bulkMove },
      canEdit && { label: 'Копировать…', icon: 'copy', onSelect: () => bulkCopy() },
      { label: 'Копировать в буфер (Ctrl+C)', icon: 'clipboard', onSelect: () => toClipboard('copy') },
      canEdit && { label: 'Вырезать (Ctrl+X)', icon: 'clipboard', onSelect: () => toClipboard('cut') },
      canEdit && files && ctx.storages.length > 1 && { label: 'Перенести в хранилище…', icon: 'server', onSelect: () => transferFiles(checkedFiles()) },
      canEdit && files && { label: 'Срок хранения…', icon: 'clock', onSelect: () => setExpiry(checkedFiles()) },
      canEdit && { label: `Удалить (${n})`, icon: 'trash', danger: true, onSelect: bulkDelete },
    ];
  }
  const selectionLabel = (files, folders) => [folders.length && pluralize(folders.length, FOLDERS), files.length && pluralize(files.length, FILES)].filter(Boolean).join(' и ');

  // Перемещение папок (каждая — со всем содержимым). Возвращает [{from, to}] для отмены.
  async function moveFoldersTo(list, target) {
    const done = [];
    for (const f of list) {
      if (target === tree.parentOf(f.path) || target.startsWith(f.path)) continue;
      try {
        const res = await api.moveFolder(f.path, { parent: target });
        refolderInLibrary(f.path, res.folder.path);
        tree.forget(f.path);
        done.push({ from: f.path, to: res.folder.path });
      } catch (err) { toast(`${f.name}: ${err.message}`, 'error'); }
    }
    return done;
  }
  function undoFolderMoves(moves) {
    return async () => {
      for (const m of [...moves].reverse()) {
        const name = m.from.slice(0, -1).split('/').pop();
        await api.moveFolder(m.to, { parent: tree.parentOf(m.from), name });
      }
    };
  }

  async function bulkMove() {
    const files = checkedFiles();
    const folders = checkedFolders();
    const target = await pickFolder({ title: `Переместить ${selectionLabel(files, folders)}`, current: folder });
    if (target === null) return;
    await moveFiles(files, target);
    if (folders.length) {
      const moves = await moveFoldersTo(folders, target);
      if (moves.length) {
        pushUndo(`перемещение ${pluralize(moves.length, FOLDERS)}`, undoFolderMoves(moves));
        toast(`Перемещено ${pluralize(moves.length, FOLDERS)} в «${folderLabel(target)}»`, 'success');
      }
      refreshAfterChange();
    }
  }

  async function bulkCopy(target) {
    const files = checkedFiles();
    const folders = checkedFolders();
    if (target === undefined) {
      target = await pickFolder({ title: `Копировать ${selectionLabel(files, folders)}`, current: folder, allowCurrent: true, confirmLabel: 'Копировать сюда' });
      if (target === null) return;
    }
    if (files.length) await copyFiles(files, target);
    if (folders.length) await copyFoldersTo(folders, target);
  }

  async function copyFoldersTo(list, target) {
    const made = [];
    for (const f of list) {
      if (target.startsWith(f.path)) { toast(`«${f.name}»: нельзя скопировать папку внутрь неё самой`, 'error'); continue; }
      try {
        const res = await api.copyFolder(f.path, target);
        made.push(res.folder.path);
      } catch (err) { toast(`${f.name}: ${err.message}`, 'error'); }
    }
    if (!made.length) return;
    pushUndo(`копирование ${pluralize(made.length, FOLDERS)}`, async () => { for (const p of made) await api.deleteFolder(p); });
    toast(`Скопировано ${pluralize(made.length, FOLDERS)} в «${folderLabel(target)}»`, 'success');
    refreshAfterChange();
  }

  // После действий над папками: список, дерево, сводка.
  function refreshAfterChange() {
    tree.reload(folder);
    ctx.refreshStats();
    if (!unmounted) load();
  }

  // ---------- буфер обмена диска: Ctrl+C / Ctrl+X → Ctrl+V ----------
  function toClipboard(mode) {
    let files = checkedFiles();
    let folders = checkedFolders();
    if (!files.length && !folders.length) { // ничего не выбрано — то, что в фокусе или открыто
      const li = document.activeElement?.closest?.('#view [role=option]');
      if (li?.dataset.key) files = state.files.filter((f) => f.key === li.dataset.key);
      else if (li?.dataset.folder) folders = state.folders.filter((f) => f.path === li.dataset.folder);
      else if (state.selected) files = state.files.filter((f) => f.key === state.selected);
    }
    if (!files.length && !folders.length) return false;
    if (mode === 'cut' && !canEdit) return false;
    clip.data = { mode, from: folder, files: files.map((f) => ({ key: f.key, name: f.name })), folders: folders.map((f) => ({ path: f.path, name: f.name })) };
    markSelection();
    toast(`${mode === 'cut' ? 'Вырезано' : 'Скопировано'}: ${selectionLabel(files, folders)} — Ctrl+V, чтобы вставить`, 'info');
    return true;
  }

  async function pasteClip() {
    const c = clip.data;
    if (!c || !canEdit) return;
    if (c.mode === 'cut') {
      clip.data = null;
      if (c.from === folder) { markSelection(); return; } // вставили туда же — ничего не делаем
      const moved = [];
      for (const f of c.files) {
        try {
          const res = await api.moveFile(f.key, { folder });
          moved.push({ key: res.file.key, from: c.from });
        } catch (err) { toast(`${f.name}: ${err.message}`, 'error'); }
      }
      const moves = await moveFoldersTo(c.folders, folder);
      if (moved.length || moves.length) {
        pushUndo('перенос', async () => {
          for (const m of moved) await api.moveFile(m.key, { folder: m.from });
          await undoFolderMoves(moves)();
        });
        toast(`Перенесено сюда: ${selectionLabel(moved, moves)}`, 'success');
      }
    } else {
      const copied = [];
      for (const f of c.files) {
        try { copied.push((await api.copyFile(f.key, { folder })).file.key); } catch (err) { toast(`${f.name}: ${err.message}`, 'error'); }
      }
      if (copied.length) {
        pushUndo(`копирование ${pluralize(copied.length, FILES)}`, async () => { await api.deleteFiles(copied); });
        toast(`Вставлено: ${pluralize(copied.length, FILES)}`, 'success');
      }
      if (c.folders.length) await copyFoldersTo(c.folders, folder);
    }
    refreshAfterChange();
  }

  // ---------- отмена последнего действия (Ctrl+Z) ----------
  async function undoLast() {
    const last = undoStack.pop();
    if (!last) return toast('Нечего отменять', 'info');
    try {
      await last.run();
      toast(`Отменено: ${last.label}`, 'success');
    } catch (err) {
      toast(`Не удалось отменить ${last.label}: ${err.message}`, 'error');
    }
    refreshAfterChange();
  }

  // Папку из списка можно бросить на другую папку.
  function makeFolderDropTarget(el, target) {
    const accepts = (e) => [...(e.dataTransfer?.types ?? [])].includes(FOLDER_DRAG);
    el.addEventListener('dragover', (e) => { if (accepts(e)) { e.preventDefault(); el.classList.add('drop-target'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', async (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      el.classList.remove('drop-target');
      const paths = e.dataTransfer.getData(FOLDER_DRAG).split('\n').filter((p) => p && p !== target && !target.startsWith(p));
      const moves = await moveFoldersTo(state.folders.filter((f) => paths.includes(f.path)), target);
      if (moves.length) {
        pushUndo(`перемещение ${pluralize(moves.length, FOLDERS)}`, undoFolderMoves(moves));
        toast(`Перемещено ${pluralize(moves.length, FOLDERS)} в «${folderLabel(target)}»`, 'success');
        refreshAfterChange();
      }
    });
  }

  // Ссылки для перетаскивания на рабочий стол: берутся при наведении (с задержкой) и живут 50 минут.
  let prefetchTimer;
  function prefetchDragUrl(file) {
    clearTimeout(prefetchTimer);
    if (dragUrls.get(file.key)?.until > Date.now()) return;
    prefetchTimer = setTimeout(async () => {
      try {
        const { url } = await api.dragLink(file.key);
        dragUrls.set(file.key, { url, until: Date.now() + 50 * 60_000 });
        if (dragUrls.size > 300) dragUrls.delete(dragUrls.keys().next().value);
      } catch { /* без ссылки файл просто не вытащить на рабочий стол */ }
    }, 350);
  }
  cleanup.push(() => clearTimeout(prefetchTimer));

  // Срок хранения: через N дней файлы сами уйдут в корзину.
  async function setExpiry(files) {
    const current = files.length === 1 && files[0].expiresAt;
    const done = await openDialog({
      title: files.length === 1 ? `Срок хранения «${files[0].name}»` : `Срок хранения: ${pluralize(files.length, FILES)}`,
      text: current ? `Сейчас: удалится в корзину ${formatDate(current)}.` : 'По истечении срока файл сам уйдёт в корзину.',
      confirmLabel: 'Сохранить',
      fields: [{ name: 'days', label: 'Удалить через', type: 'select', value: current ? '' : '30', options: [
        ['', 'Не удалять'], ['1', '1 день'], ['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней'], ['365', '1 год'],
      ] }],
      onSubmit: ({ days }) => api.setExpiry(files.map((f) => f.key), days ? Number(days) : null),
    });
    if (!done) return;
    for (const f of files) f.expiresAt = done.expiresAt ?? undefined;
    renderList();
    toast(done.expiresAt ? `Удалится в корзину ${formatDate(done.expiresAt)}` : 'Срок хранения снят', 'success');
  }

  // Архив собирается на сервере потоком; браузер сразу начинает скачивание.
  async function downloadZip(what) {
    try {
      const { url, count } = await api.archive(what);
      toast(`Архив: ${count} ${pluralize(count, FILES)} — скачивание началось`, 'success');
      window.location.assign(url);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function bulkCopyLinks() {
    const files = checkedFiles();
    const ttl = Number(prefs.get('link-ttl', '86400'));
    const lines = [];
    await eachLimited(files, async (file) => {
      const { url } = await api.downloadLink(file.key, ttl);
      lines.push([files.indexOf(file), `${file.name}: ${url}`]);
    });
    if (!lines.length) return;
    try {
      await copyToClipboard(lines.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join('\n'));
      toast(`Скопировано ссылок: ${lines.length} · действуют ${TTL_LABELS[ttl] ?? ''}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---------- папки ----------
  async function deleteFolder(f) {
    if (!(await confirmDialog('Удалить папку?', `Папка «${f.name}» и всё её содержимое (включая вложенные папки) ${trashNote('будут перемещены', 'будут удалены')}`))) return;
    try {
      const { deleted, trashId } = await api.deleteFolder(f.path);
      if (trashId) pushUndo(`удаление папки «${f.name}»`, () => api.restoreTrash(trashId));
      tree.forget(f.path);
      forgetFolder(f.path);
      if (tree.parentOf(f.path) === folder) {
        state.folders = state.folders.filter((x) => x.path !== f.path);
        tree.setChildren(folder, state.folders);
        renderList();
      } else { // из дерева слева: папка не в текущей
        tree.reload(tree.parentOf(f.path));
        if (folder.startsWith(f.path)) ctx.navigate(diskHash(tree.parentOf(f.path)));
      }
      ctx.refreshStats();
      toast(trashId ? `Папка в корзине (объектов: ${deleted})` : `Папка удалена (объектов: ${deleted})`, 'success', undoAction(trashId));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function renameFolder(f) {
    await openDialog({
      title: 'Переименовать папку',
      text: 'Всё содержимое переедет вместе с папкой. Публичные ссылки и метки сохранятся; ссылки на скачивание, выданные раньше, перестанут работать.',
      confirmLabel: 'Переименовать',
      fields: [{ name: 'name', label: 'Новое название', value: f.name, maxlength: 100, select: [0, f.name.length] }],
      async onSubmit({ name }) {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Введите название папки');
        if (trimmed === f.name) return {};
        const res = await api.moveFolder(f.path, { name: trimmed });
        applyFolderMoved(f, res.folder);
        toast(`Папка переименована в «${res.folder.name}»`, 'success');
        return res;
      },
    });
  }

  async function moveFolder(f) {
    const parent = f.path.slice(0, f.path.length - f.name.length - 1);
    const target = await pickFolder({ title: `Переместить папку «${f.name}»`, current: parent });
    if (target === null || target === parent) return;
    if (target.startsWith(f.path)) return toast('Нельзя переместить папку внутрь неё самой', 'error');
    try {
      const res = await api.moveFolder(f.path, { parent: target });
      applyFolderMoved(f, res.folder);
      toast(`Папка перемещена в «${folderLabel(target)}»`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function applyFolderMoved(f, moved) {
    const old = f.path;
    pushUndo(moved.name !== f.name ? `переименование папки «${f.name}»` : `перемещение папки «${f.name}»`,
      undoFolderMoves([{ from: old, to: moved.path }]));
    refolderInLibrary(old, moved.path);
    tree.forget(old);
    if (tree.parentOf(old) !== folder) { // из дерева слева: папка не в текущей
      tree.reload(tree.parentOf(old));
      tree.reload(tree.parentOf(moved.path));
      if (folder.startsWith(old)) ctx.navigate(diskHash(moved.path + folder.slice(old.length)));
      else if (tree.parentOf(moved.path) === folder) load();
      return;
    }
    const stays = moved.path.slice(0, moved.path.length - moved.name.length - 1) === folder;
    state.folders = state.folders.filter((x) => x.path !== old);
    if (stays) state.folders = [...state.folders, { ...f, path: moved.path, name: moved.name }].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    tree.setChildren(folder, state.folders);
    renderList();
    ctx.refreshStats();
  }

  function addFolder(created) {
    if (state.folders.some((x) => x.path === created.path)) return;
    state.folders = [...state.folders, created].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    tree.setChildren(folder, state.folders);
  }

  async function newFolder() {
    await openDialog({
      title: 'Новая папка',
      fields: [{ name: 'name', label: 'Название', maxlength: 100 }],
      confirmLabel: 'Создать',
      async onSubmit({ name }) {
        if (!name.trim()) throw new Error('Введите название папки');
        const { folder: created } = await api.createFolder(folder, name);
        addFolder(created);
        pushUndo(`создание папки «${created.name}»`, () => api.deleteFolder(created.path));
        renderList();
        ctx.refreshStats();
        toast(`Папка «${created.name}» создана`, 'success');
      },
    });
  }
  ctx.newFolderHere = canEdit ? newFolder : null;
  ctx.currentFolder = () => folder;
  // Для проверки дубликатов при загрузке: файлы, которые уже есть в этой папке.
  ctx.existingFiles = (target) => (target === folder ? state.files : null);

  // ---------- загрузка: перетаскивание и вставка ----------
  if (canEdit) {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const show = (visibleNow) => { overlay.classList.toggle('hidden', !visibleNow); overlay.classList.toggle('flex', visibleNow); };
    on(window, 'dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; show(true); });
    on(window, 'dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) show(false); });
    on(window, 'dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    on(window, 'drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      show(false);
      const dropped = await collectDropped(e.dataTransfer);
      if (dropped.length >= MAX_DROPPED_FILES) toast(`Загружаются первые ${MAX_DROPPED_FILES} файлов`, 'error');
      if (dropped.length) ctx.enqueue(dropped, folder);
      else toast('В перетащенных папках нет файлов', 'error');
    });
    on(window, 'paste', (e) => {
      if (isTyping(document.activeElement) || document.querySelector('dialog[open]')) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) { // Ctrl+V без файлов в буфере системы — вставить скопированное на диске
        if (clip.data) { e.preventDefault(); pasteClip(); }
        return;
      }
      e.preventDefault();
      ctx.enqueue(files.map((f) => new File([f], pastedName(f), { type: f.type, lastModified: f.lastModified })), folder);
    });
  }

  load();

  return {
    // Загрузка завершилась: файл в этой папке — добавляем; в её подпапке — показываем подпапку.
    onUploaded(file, targetFolder) {
      if (targetFolder === folder) {
        if (state.files.some((f) => f.key === file.key)) return;
        state.files.unshift(file);
      } else if (targetFolder.startsWith(folder)) {
        const name = targetFolder.slice(folder.length).split('/')[0];
        addFolder({ path: `${folder}${name}/`, name });
      } else {
        return;
      }
      renderList();
    },
    // Перенос в другое хранилище завершён: ключ файла сменился (префикс хранилища).
    onTransferred(oldKey, file) {
      if (!state.files.some((f) => f.key === oldKey)) return;
      applyMoved(oldKey, file, folder);
      renderList();
    },
    // Загрузка с заменой: старые версии файла удалены.
    onReplaced(keys) {
      removeFiles(keys);
      renderList();
    },
    refresh,
    unmount() {
      unmounted = true;
      cleanup.forEach((fn) => fn());
      ctx.newFolderHere = null;
      ctx.currentFolder = null;
      ctx.existingFiles = null;
      tree.setDropHandler(null);
      tree.setMenuHandler(null);
      ctx.onPreviewClosed = null;
      ctx.onCommentsChanged = null;
      setPreviewEnabled(false);
      tree.clearActive();
    },
  };
}
