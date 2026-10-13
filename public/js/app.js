// Оболочка приложения: роутер (#/...), левая панель (навигация + дерево диска),
// заголовок страницы, очередь загрузок. Разделы — в ./views/*.
import { api } from './api.js';
import { favorites, initLibrary, onLibraryChange, toggleFavorite } from './library.js';
import { initPalette } from './palette.js';
import { initPreview } from './preview.js';
import { ProgressView } from './progress.js';
import * as tree from './tree.js';
import { $, applyTheme, FILES, formatSize, h, icon, pluralize, prefs, toast } from './ui.js';
import { uploadFile, UploadCancelled } from './uploader.js';
import { diskHash, mountDisk } from './views/disk.js';
import { mountHome } from './views/home.js';
import { mountSettings } from './views/settings.js';
import { mountUsers } from './views/users.js';

const ROLE_LABELS = { viewer: 'Просмотр', editor: 'Редактор', admin: 'Администратор' };
const ROLE_ORDER = ['viewer', 'editor', 'admin'];
const FILE_CONCURRENCY = 2;

const ctx = {
  user: null,
  can: (role) => ROLE_ORDER.indexOf(ctx.user?.role) >= ROLE_ORDER.indexOf(role),
  roleLabel: (role) => ROLE_LABELS[role] ?? role,
  navigate: (hash) => { if (location.hash === hash) route(); else location.hash = hash; },
  setHeader(title, actions = []) {
    $('#page-title').replaceChildren(title);
    $('#page-actions').replaceChildren(...actions);
  },
  pickFiles(folder) {
    uploadTarget = folder;
    $('#file-input').click();
  },
  // Папка целиком (с подпапками): браузер отдаёт файлы с webkitRelativePath «Фото/2026/a.jpg».
  pickFolder(folder) {
    uploadTarget = folder;
    $('#folder-input').click();
  },
  enqueue,
  refreshStats,
  selectAfterNavigate: null,
  newFolderHere: null,
  storageConfigured: true,
  setStorageConfigured,
  // Хранилища единого диска: [{id, name}]. Названия показываются, только если их больше одного.
  storages: [],
  storageName: (id) => ctx.storages.find((s) => s.id === id)?.name ?? id,
  setStorages(list) {
    ctx.storages = list.map(({ id, name }) => ({ id, name }));
    setStorageConfigured(list.length > 0);
  },
};

// Пока администратор не указал хранилище S3 — баннер и никаких запросов к нему.
function setStorageConfigured(value) {
  const was = ctx.storageConfigured;
  ctx.storageConfigured = value;
  const banner = $('#storage-banner');
  banner.classList.toggle('hidden', value);
  banner.classList.toggle('flex', !value);
  if (!value) {
    banner.replaceChildren(icon('alert'), h('span', { class: 'flex-1' },
      ctx.can('admin') ? 'Не подключено ни одного хранилища S3 — файлы пока недоступны.' : 'Хранилище файлов ещё не настроено. Обратитесь к администратору.'),
    ctx.can('admin') && h('a', { href: '#/settings', class: 'font-medium underline' }, 'Настроить'));
  }
  if (value && !was) {
    tree.reload('');
    refreshStats();
  }
}

// ---------- левая панель ----------
function initSidebar() {
  const navIcons = { home: ['home', 'Главная'], users: ['users', 'Пользователи'], settings: ['settings', 'Настройки'] };
  for (const a of document.querySelectorAll('[data-nav]')) {
    const [ic, label] = navIcons[a.dataset.nav];
    a.replaceChildren(icon(ic), label);
  }
  for (const el of document.querySelectorAll('[data-role]')) {
    if (!ctx.can(el.dataset.role)) el.remove();
  }
  $('#sidebar-open').append(icon('menu', 'h-5 w-5'));
  $('#sidebar-close').append(icon('close'));
  $('#logout').append(icon('logout'));
  $('#tree-new-folder')?.append(icon('plus'));
  $('#uploads-hide').append(icon('close'));

  const sidebar = $('#sidebar');
  const backdrop = $('#sidebar-backdrop');
  const open = (on) => {
    sidebar.classList.toggle('-translate-x-full', !on);
    backdrop.classList.toggle('hidden', !on);
  };
  $('#sidebar-open').addEventListener('click', () => open(true));
  $('#sidebar-close').addEventListener('click', () => open(false));
  backdrop.addEventListener('click', () => open(false));
  window.addEventListener('hashchange', () => open(false));

  $('#user-avatar').textContent = ctx.user.username.slice(0, 1);
  $('#user-name').textContent = ctx.user.username;
  $('#user-role').textContent = ctx.roleLabel(ctx.user.role);
  $('#logout').addEventListener('click', async () => {
    if (active > 0 && !window.confirm('Идёт загрузка файлов. Выйти и прервать её?')) return;
    await api.logout().catch(() => {});
    window.location.replace('/login');
  });

  // «+» у дерева: новая папка в текущей папке диска (или в корне с других страниц).
  $('#tree-new-folder')?.addEventListener('click', () => {
    if (ctx.newFolderHere) ctx.newFolderHere();
    else { ctx.navigate(diskHash('')); setTimeout(() => ctx.newFolderHere?.(), 0); }
  });

  tree.initTree($('#tree'), (path) => ctx.navigate(diskHash(path)), { load: ctx.storageConfigured });

  $('#palette-icon').append(icon('search'));
  renderFavorites();
  onLibraryChange(renderFavorites);
}

// «Избранное» в левой панели: папки и файлы, закреплённые пользователем.
function renderFavorites() {
  const list = favorites();
  $('#favorites').classList.toggle('hidden', !list.length);
  $('#favorites-list').replaceChildren(...list.map((f) => {
    const isFolder = f.type === 'folder';
    const link = h('a', {
      href: diskHash(isFolder ? f.path : f.folder),
      class: 'nav-link min-w-0 flex-1 py-1.5',
      title: f.name,
      onclick: () => { if (!isFolder) ctx.selectAfterNavigate = f.key; },
    }, icon(isFolder ? 'folder' : 'file', 'h-4 w-4 text-amber-500'), h('span', { class: 'truncate font-normal' }, f.name));
    const remove = h('button', {
      type: 'button', class: 'icon-btn fav-remove h-7 w-7', title: 'Убрать из избранного', 'aria-label': `Убрать «${f.name}» из избранного`,
      onclick: () => toggleFavorite(f),
    }, icon('close', 'h-3.5 w-3.5'));
    return h('li', { class: 'fav-item flex items-center' }, link, remove);
  }));
}

let statsTimer;
function refreshStats() {
  clearTimeout(statsTimer);
  if (!ctx.storageConfigured) return;
  statsTimer = setTimeout(async () => {
    try {
      const s = await api.stats();
      $('#storage-summary').replaceChildren(
        h('div', { class: 'flex items-center justify-between' },
          h('span', {}, 'Занято'),
          h('span', { class: 'font-medium tabular-nums text-slate-700 dark:text-slate-200' }, formatSize(s.size))),
        h('div', { class: 'mt-0.5' }, `${pluralize(s.files, FILES)}${s.complete ? '' : '+'}`));
    } catch { /* не критично */ }
  }, 300);
}

// ---------- роутер ----------
let current = null;
let currentRoute = '';

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (raw === 'disk' || raw.startsWith('disk/')) {
    let folder = '';
    try {
      folder = raw.slice(5).split('/').filter(Boolean).map(decodeURIComponent).join('/');
    } catch { /* битый URL — в корень */ }
    return { name: 'disk', folder: folder ? `${folder}/` : '' };
  }
  return { name: ['users', 'settings'].includes(raw) ? raw : 'home' };
}

function route() {
  let r = parseHash();
  if (r.name === 'users' && !ctx.can('admin')) r = { name: 'home' };
  const id = `${r.name}:${r.folder ?? ''}`;
  if (id === currentRoute && !ctx.selectAfterNavigate) return;
  currentRoute = id;

  current?.unmount();
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const view = $('#view');
  view.scrollTop = 0;
  if (r.name === 'disk') {
    const selectKey = ctx.selectAfterNavigate;
    ctx.selectAfterNavigate = null;
    current = mountDisk(view, ctx, r.folder, { selectKey });
  } else if (r.name === 'users') current = mountUsers(view, ctx);
  else if (r.name === 'settings') current = mountSettings(view, ctx);
  else current = mountHome(view, ctx);
  const titles = { home: 'Главная', disk: 'Диск', users: 'Пользователи', settings: 'Настройки' };
  document.title = `${titles[r.name]} — Файлообменник`;
}

// ---------- загрузки ----------
const queue = [];
let active = 0;
let uploadTarget = '';
let finished = 0;
let failed = 0;
let hideTimer;

function updateUploadsTitle() {
  const pending = active + queue.length;
  $('#uploads-title').textContent = pending ? `Загрузка · осталось ${pending}` : `Готово · ${pluralize(finished, FILES)}`;
}

// ---------- файлы с такими же именами ----------
// Спрашиваем, что делать: заменить (старый удаляется после успешной загрузки),
// сохранить оба (новому — «имя (1).ext») или пропустить. Можно применить ко всем.
function askDuplicate(name, left) {
  return new Promise((resolve) => {
    let result = { action: 'skip', all: false };
    const all = h('input', { type: 'checkbox', id: 'dup-all', class: 'check' });
    const choose = (action) => () => { result = { action, all: all.checked }; dialog.close(); };
    const dialog = h('dialog', { class: 'w-[min(30rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200', 'aria-labelledby': 'dup-title' },
      h('div', { class: 'space-y-4 p-6' },
        h('h3', { id: 'dup-title', class: 'text-lg font-semibold' }, 'Такой файл уже есть'),
        h('p', { class: 'break-words text-sm text-slate-500 dark:text-slate-400' }, `В этой папке уже есть «${name}».`),
        left > 0 && h('label', { for: 'dup-all', class: 'flex items-center gap-2 text-sm' }, all, `Применить ко всем совпадениям (ещё ${left})`),
        h('div', { class: 'flex flex-wrap justify-end gap-2 pt-1' },
          h('button', { type: 'button', class: 'btn-ghost', onclick: choose('skip') }, 'Пропустить'),
          h('button', { type: 'button', class: 'btn-ghost', onclick: choose('keep') }, 'Сохранить оба'),
          h('button', { type: 'button', class: 'btn-primary', onclick: choose('replace') }, 'Заменить'))));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.btn-primary').focus();
  });
}

function freeName(name, taken) {
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

async function resolveDuplicates(items, folder) {
  const existing = ctx.existingFiles?.(folder);
  if (!existing?.length) return items;
  const byName = new Map();
  for (const f of existing) {
    const k = f.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f.key);
  }
  const taken = new Set(byName.keys());
  const dupCount = items.filter((it) => !it.subfolders?.length && byName.has(it.file.name.toLowerCase())).length;
  let seen = 0;
  let always = null;
  const out = [];
  for (const item of items) {
    const lower = item.file.name.toLowerCase();
    if (item.subfolders?.length || !byName.has(lower)) { taken.add(lower); out.push(item); continue; }
    seen++;
    let action = always;
    if (!action) {
      const choice = await askDuplicate(item.file.name, dupCount - seen);
      action = choice.action;
      if (choice.all) always = action;
    }
    if (action === 'skip') continue;
    if (action === 'replace') {
      out.push({ ...item, replaceKeys: byName.get(lower) });
    } else {
      const name = freeName(item.file.name, taken);
      taken.add(name.toLowerCase());
      out.push({ ...item, file: new File([item.file], name, { type: item.file.type, lastModified: item.file.lastModified }) });
    }
  }
  return out;
}

// files: File или { file, subfolders } (загрузка папки целиком — путь внутри неё).
async function enqueue(files, folder) {
  if (!ctx.can('editor')) return toast('Недостаточно прав для загрузки', 'error');
  files = await resolveDuplicates(files.map((it) => (it instanceof File ? { file: it } : it)), folder);
  if (!files.length) return;
  clearTimeout(hideTimer);
  if (!active && !queue.length) { finished = 0; failed = 0; $('#upload-list').replaceChildren(); }
  $('#uploads').classList.remove('hidden');
  for (const item of files) {
    const { file, subfolders = [], replaceKeys } = item;
    const label = [...subfolders, file.name].join(' / ');
    const controller = new AbortController();
    const status = h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400' }, `${formatSize(file.size)} · в очереди`);
    const bar = h('div');
    const cancel = h('button', { type: 'button', class: 'icon-btn h-7 w-7', title: 'Отменить', 'aria-label': `Отменить загрузку ${file.name}` }, icon('close'));
    cancel.onclick = () => controller.abort();
    const row = h('li', { class: 'upload-row flex items-center gap-3 px-4 py-3' },
      h('div', { class: 'min-w-0 flex-1' },
        h('div', { class: 'flex items-baseline justify-between gap-3' },
          h('p', { class: 'truncate text-sm font-medium', title: label }, label),
          status),
        h('div', { class: 'progress mt-2' }, bar)),
      cancel);
    $('#upload-list').append(row);
    queue.push({ file, folder, subfolders: subfolders.length ? subfolders : undefined, replaceKeys, controller, ui: { row, status, bar, cancel } });
  }
  updateUploadsTitle();
  pump();
}

function pump() {
  while (active < FILE_CONCURRENCY && queue.length) {
    active++;
    runUpload(queue.shift()).finally(() => {
      active--;
      updateUploadsTitle();
      if (!active && !queue.length) {
        refreshStats();
        // Всё загрузилось без ошибок — панель прячется сама; при ошибках остаётся.
        if (!failed) hideTimer = setTimeout(() => $('#uploads').classList.add('hidden'), 4000);
      }
      pump();
    });
  }
}

async function runUpload({ file, folder, subfolders, replaceKeys, controller, ui }) {
  const { status, bar, row, cancel } = ui;
  if (controller.signal.aborted) { row.remove(); return; }
  const progress = new ProgressView(bar, status, file.size);
  status.textContent = '0%';
  try {
    const result = await uploadFile(file, {
      folder,
      subfolders,
      signal: controller.signal,
      onProgress: (loaded) => progress.update(loaded),
    });
    finished++;
    progress.finish(true);
    status.textContent = 'Готово';
    cancel.replaceChildren(icon('check'));
    cancel.disabled = true;
    current?.onUploaded?.(result.file, result.folder);
    // «Заменить»: новая версия уже загружена — удаляем прежнюю.
    if (replaceKeys?.length) {
      const removed = [];
      for (const key of replaceKeys) await api.deleteFile(key).then(() => removed.push(key)).catch(() => {});
      current?.onReplaced?.(removed);
    }
  } catch (err) {
    if (err instanceof UploadCancelled) { row.remove(); return; }
    failed++;
    progress.finish(false);
    status.textContent = 'Ошибка';
    status.classList.add('text-rose-600');
    cancel.title = 'Скрыть';
    cancel.onclick = () => row.remove();
    toast(`${file.name}: ${err.message}`, 'error');
  }
}

window.addEventListener('beforeunload', (event) => {
  if (active > 0 || queue.length > 0) event.preventDefault();
});

// ---------- старт ----------
async function start() {
  try {
    const me = await api.me();
    ctx.user = me.user;
    ctx.storageConfigured = me.storageConfigured;
    ctx.storages = me.storages ?? [];
  } catch {
    return; // при 401 api сам перенаправит на /login
  }
  initLibrary(ctx.user.username);
  initSidebar();
  initPalette(ctx);
  initPreview(ctx);
  setStorageConfigured(ctx.storageConfigured);

  $('#folder-input').addEventListener('change', (e) => {
    const items = [...e.target.files]
      .filter((f) => !['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(f.name))
      .map((file) => ({ file, subfolders: (file.webkitRelativePath || file.name).split('/').slice(0, -1) }));
    if (items.length) enqueue(items, uploadTarget);
    e.target.value = '';
  });
  $('#file-input').addEventListener('change', (e) => {
    enqueue([...e.target.files], uploadTarget);
    e.target.value = '';
  });
  $('#uploads-hide').addEventListener('click', () => $('#uploads').classList.add('hidden'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (prefs.get('theme', 'system') === 'system') applyTheme('system');
  });

  window.addEventListener('hashchange', route);
  route();
  refreshStats();
}

start();
