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
  categoryOf, confirmDialog, copyToClipboard, DRAG_TYPE, FILES, folderLabel, FOLDERS, formatDate, formatDateShort, formatSize, h, homeFolder, icon,
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

const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

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
    checked: new Set(), // выбранные (несколько) файлы
    anchor: null, // для выбора диапазона с Shift
    layout: prefs.get('layout', 'list') === 'grid' ? 'grid' : 'list',
    sort: SORTS[sortBy] ? { by: sortBy, dir: sortDir === 'asc' ? 'asc' : 'desc' } : { by: 'date', dir: 'desc' },
  };
  const cleanup = [];
  let unmounted = false;
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
    h('button', { type: 'button', class: 'btn-ghost px-2.5 py-1.5', onclick: () => bulkCopyLinks() }, toned('link'), h('span', { class: 'hidden xl:inline' }, 'Ссылки')),
    canEdit && h('button', { type: 'button', class: 'btn-ghost px-2.5 py-1.5', onclick: () => bulkMove() }, toned('move'), h('span', { class: 'hidden xl:inline' }, 'Переместить')),
    canEdit && h('button', { type: 'button', class: 'btn-ghost px-2.5 py-1.5', title: 'Копировать', 'aria-label': 'Копировать выбранные', onclick: () => copyFiles(checkedFiles()) }, toned('copy'), h('span', { class: 'hidden 2xl:inline' }, 'Копировать')),
    canEdit && ctx.storages.length > 1 && h('button', { type: 'button', class: 'btn-ghost px-2.5 py-1.5', title: 'Перенести в другое хранилище', 'aria-label': 'Перенести выбранные в другое хранилище', onclick: () => transferFiles(checkedFiles()) }, toned('server')),
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
  const head = h('div', { class: 'list-head hidden items-center gap-4 border-b border-slate-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-400 md:grid dark:border-slate-800' },
    h('span', { class: 'flex items-center gap-3' }, h('span', { class: 'check-cell' }, checkAll), sortHeader('name', 'Имя')),
    sortHeader('size', 'Размер', 'justify-end'), sortHeader('date', 'Изменён'), h('span', { class: 'text-right' }, 'Действия'));

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
    canEdit && { label: 'Поделиться…', icon: 'globe', onSelect: () => openShareDialog({ folder: f.path }) },
    canEdit && { label: 'Переименовать', icon: 'pencil', onSelect: () => renameFolder(f) },
    canEdit && { label: 'Переместить…', icon: 'move', onSelect: () => moveFolder(f) },
    { more: [
      favoriteItem({ type: 'folder', path: f.path, name: f.name }),
      canEdit && labelMenuItem(() => btn, { folder: f.path }, f, () => renderList()),
      ctx.can('admin') && { label: 'Доступ…', icon: 'lock', onSelect: async () => { if (await openAclDialog(f.path)) load(); } },
    ] },
    canEdit && { label: 'Удалить папку', icon: 'trash', danger: true, onSelect: () => deleteFolder(f) },
  ]);

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
    const li = h('li', {
      class: grid ? 'tile' : 'file-row', role: 'option', 'aria-selected': 'false', tabindex: '-1', dataset: { folder: f.path },
      onclick: () => ctx.navigate(diskHash(f.path)),
      onkeydown: (e) => { if (e.target === e.currentTarget && e.key === 'Enter') ctx.navigate(diskHash(f.path)); },
    },
    grid
      ? [h('span', { class: 'tile-media bg-brand-50 text-brand-600 dark:bg-brand-950/50 dark:text-brand-400' }, icon('folder', 'h-10 w-10')),
        h('span', { class: 'tile-body' },
          h('span', { class: 'flex min-w-0 items-center gap-1.5' }, labelDot(f.label), h('span', { class: 'block truncate text-sm font-medium', title: f.name }, f.name), folderBadge(f)),
          h('span', { class: 'block text-xs text-slate-500 dark:text-slate-400' }, 'Папка')),
        h('span', { class: 'tile-actions' }, actionBtn('more', 'Действия с папкой', folderMenu(f)))]
      : [h('div', { class: 'flex min-w-0 items-center gap-3' },
        h('span', { class: 'check-cell' }),
        h('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400' }, icon('folder')),
        h('div', { class: 'min-w-0' },
          h('div', { class: 'flex min-w-0 items-center gap-2' }, h('p', { class: 'truncate text-sm font-medium', title: f.name }, f.name), labelDot(f.label), folderBadge(f)),
          h('p', { class: 'text-xs text-slate-500 md:hidden dark:text-slate-400' }, 'Папка'))),
      h('span', { class: 'hidden text-right text-sm text-slate-400 md:block' }, '—'),
      h('span', { class: 'hidden text-sm text-slate-500 md:block dark:text-slate-400' }, 'Папка'),
      h('div', { class: 'row-actions flex justify-end gap-0.5' },
        actionBtn('more', 'Действия с папкой', folderMenu(f)))]);
    if (canEdit) makeDropTarget(li, (keys) => moveByKeys(keys, f.path));
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
        if (state.checked.size) return toggleChecked(file.key); // в режиме выбора клик выбирает
        select(file);
      },
      ondragstart: (e) => {
        // Перетаскиваем все выбранные файлы, если тянем один из них.
        const keys = state.checked.has(file.key) ? [...state.checked] : [file.key];
        e.dataTransfer.setData(DRAG_TYPE, keys.join('\n'));
        e.dataTransfer.effectAllowed = 'move';
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
    const files = state.files.filter((f) => match(f.name)).sort((a, b) => sign * SORTS[by].cmp(a, b));
    return { folders, files };
  }

  function renderList() {
    const { folders, files } = visible();
    const focusedKey = document.activeElement?.closest?.('#view [role=option]')?.dataset;
    list.className = state.layout === 'grid' ? 'file-grid' : 'file-list';
    head.classList.toggle('md:grid', state.layout === 'list');
    list.replaceChildren(...folders.map(folderItem), ...files.map(fileItem));
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

  function renderBulk() {
    // Выбор мог включать файлы, которых уже нет (удалены, перемещены).
    for (const key of state.checked) if (!state.files.some((f) => f.key === key)) state.checked.delete(key);
    const n = state.checked.size;
    bulkBar.classList.toggle('hidden', !n);
    bulkBar.classList.toggle('flex', n > 0);
    summary.classList.toggle('hidden', n > 0);
    bulkCount.textContent = `Выбрано: ${n}`;
    bulkCount.title = pluralize(n, FILES);
    card.classList.toggle('has-selection', n > 0);
    const files = visible().files;
    checkAll.checked = n > 0 && files.every((f) => state.checked.has(f.key));
    checkAll.indeterminate = n > 0 && !checkAll.checked;
  }

  function markSelection() {
    for (const li of list.querySelectorAll('[data-key]')) {
      const key = li.dataset.key;
      li.setAttribute('aria-selected', String(state.checked.has(key) || state.selected === key));
      const box = li.querySelector('.check');
      if (box) box.checked = state.checked.has(key);
    }
    renderBulk();
  }

  // ---------- выбор ----------
  function toggleChecked(key, range = false) {
    const files = visible().files;
    if (range && state.anchor) {
      const a = files.findIndex((f) => f.key === state.anchor);
      const b = files.findIndex((f) => f.key === key);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.checked.add(files[i].key);
        return markSelection();
      }
    }
    if (state.checked.has(key)) state.checked.delete(key);
    else state.checked.add(key);
    state.anchor = key;
    markSelection();
  }
  function checkAllFiles() {
    for (const f of visible().files) state.checked.add(f.key);
    markSelection();
  }
  function clearChecked() {
    state.checked.clear();
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
    showPreview(file, canEdit
      ? { folder, gallery, onDelete: deleteFile, onRename: renameFile, onMove: moveFile }
      : { folder, gallery });
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
    ]);
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
      if (e.shiftKey && file) {
        const next = items()[Math.max(0, Math.min(all.length - 1, i + step))]?.dataset.key;
        if (next) { state.checked.add(key); state.checked.add(next); state.anchor = next; markSelection(); }
      }
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusAt(e.key === 'Home' ? 0 : all.length - 1);
    } else if (file && (e.key === 'Enter' || (e.key === ' ' && !state.checked.size))) {
      e.preventDefault();
      select(file);
    } else if (file && e.key === ' ') {
      e.preventDefault();
      toggleChecked(key);
    } else if (file && e.key === 'x') {
      toggleChecked(key);
    } else if (canEdit && e.key === 'Delete') {
      e.preventDefault();
      if (state.checked.size) bulkDelete();
      else if (file) deleteFile(file);
    } else if (canEdit && file && e.key === 'F2') {
      e.preventDefault();
      renameFile(file);
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
      if (state.checked.size > 1 && state.checked.has(file.key)) {
        return openMenu(atPointer(e), [
          { label: `Скопировать ссылки (${state.checked.size})`, icon: 'link', onSelect: bulkCopyLinks },
          canEdit && { label: 'Переместить…', icon: 'move', onSelect: bulkMove },
          canEdit && { label: 'Копировать…', icon: 'copy', onSelect: () => copyFiles(checkedFiles()) },
          canEdit && ctx.storages.length > 1 && { label: 'Перенести в хранилище…', icon: 'server', onSelect: () => transferFiles(checkedFiles()) },
          canEdit && { label: `Удалить (${state.checked.size})`, icon: 'trash', danger: true, onSelect: bulkDelete },
        ]);
      }
      return fileMenu(file)(atPointer(e));
    }
    if (item?.dataset.folder !== undefined) {
      const f = state.folders.find((x) => x.path === item.dataset.folder);
      if (f) { e.preventDefault(); folderMenu(f)(atPointer(e)); }
      return;
    }
    if (!canEdit) return;
    e.preventDefault();
    openMenu(atPointer(e), [
      { label: 'Загрузить файлы', icon: 'upload', onSelect: () => ctx.pickFiles(folder) },
      { label: 'Загрузить папку', icon: 'folderUp', onSelect: () => ctx.pickFolder(folder) },
      { label: 'Загрузить по ссылке…', icon: 'globe', onSelect: () => ctx.importFromUrl(folder) },
      { label: 'Новая папка', icon: 'folderPlus', onSelect: newFolder },
      state.files.length && { label: 'Выбрать все файлы', icon: 'check', onSelect: checkAllFiles },
    ]);
  });

  // ---------- выделение рамкой (мышью по пустому месту) ----------
  on(view, 'pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType !== 'mouse') return;
    if (e.target.closest('[role=option], button, a, input, label, select, textarea, .dropzone, .bulk-bar, .list-head')) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const base = additive ? new Set(state.checked) : new Set();
    const start = { x: e.clientX, y: e.clientY };
    let band = null;
    e.preventDefault(); // без выделения текста при протягивании
    const move = (ev) => {
      if (!band && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      if (!band) { band = h('div', { class: 'select-band', 'aria-hidden': 'true' }); document.body.append(band); }
      const x1 = Math.min(start.x, ev.clientX); const x2 = Math.max(start.x, ev.clientX);
      const y1 = Math.min(start.y, ev.clientY); const y2 = Math.max(start.y, ev.clientY);
      Object.assign(band.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
      state.checked = new Set(base);
      for (const li of list.querySelectorAll('[data-key]')) {
        const r = li.getBoundingClientRect();
        if (r.right > x1 && r.left < x2 && r.bottom > y1 && r.top < y2) state.checked.add(li.dataset.key);
      }
      markSelection();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (band) band.remove();
      else if (!additive && state.checked.size) clearChecked(); // клик по пустому месту снимает выбор
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  on(document, 'keydown', (e) => {
    if (document.querySelector('dialog[open]') || isTyping(document.activeElement)) {
      if (e.key === 'Escape' && document.activeElement === search && search.value) { search.value = ''; state.query = ''; renderList(); }
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); search.focus(); search.select(); }
    else if (e.key === '?') { e.preventDefault(); showShortcuts(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); checkAllFiles(); }
    else if (e.key === 'Escape' && state.checked.size) clearChecked();
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
          row(['Ctrl', 'клик'], 'Выбрать несколько файлов'),
          row(['Shift', 'клик'], 'Выбрать диапазон'),
          row(['Ctrl', 'A'], 'Выбрать все файлы папки'),
          row(['Esc'], 'Снять выбор'),
          canEdit && row(['F2'], 'Переименовать'),
          canEdit && row(['Delete'], 'Удалить'),
          canEdit && row(['Ctrl', 'V'], 'Загрузить из буфера обмена'),
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
    const failed = await eachLimited(files, async (file) => {
      const res = await api.moveFile(file.key, { folder: target });
      applyMoved(file.key, res.file, res.folder);
    });
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
    if (!files.length) return;
    if (!(await confirmDialog(`Удалить ${pluralize(files.length, FILES)}?`, `Файлы ${trashNote('будут перемещены', 'будут удалены')} Выданные ссылки перестанут работать.`))) return;
    const done = [];
    const trashIds = [];
    let failed = 0;
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
    if (done.length) toast(`${trashIds.length ? 'В корзине' : 'Удалено'}: ${pluralize(done.length, FILES)}`, 'success', undoAction(...trashIds));
    if (failed) { toast(`Не удалось удалить: ${pluralize(failed, FILES)}`, 'error'); load(); }
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
      if (!files.length) return;
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
      setPreviewEnabled(false);
      tree.clearActive();
    },
  };
}
