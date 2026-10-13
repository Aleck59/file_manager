// Оболочка приложения: роутер (#/...), левая панель (навигация + дерево диска),
// заголовок страницы, очередь загрузок. Разделы — в ./views/*.
import { api } from './api.js';
import { favorites, initLibrary, onLibraryChange, toggleFavorite } from './library.js';
import { initPalette } from './palette.js';
import { forgetUpload, initPending, pendingUploads, rememberUpload } from './pending-uploads.js';
import { initPreview } from './preview.js';
import { ProgressView } from './progress.js';
import * as tree from './tree.js';
import { $, applyTheme, confirmDialog, FILES, folderLabel, formatSize, h, icon, openDialog, pluralize, prefs, toast, toned } from './ui.js';
import { speedLimit, UploadCancelled, UploadControl, uploadFile } from './uploader.js';
import { diskHash, mountDisk, pathForId, rememberFolderId } from './views/disk.js';
import { mountAudit } from './views/audit.js';
import { mountShares } from './views/shares.js';
import { mountTrash } from './views/trash.js';
import { mountSearch, parseSearchHash } from './views/search.js';
import { inboxItems, mountInbox } from './views/inbox.js';
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
  importFromUrl,
  enqueueFiles: (files, folder) => enqueue(files, folder),
  trackJob: (job, opts) => trackJob(job, opts),
  transferFile,
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

// Часы сервера расходятся с хранилищем: ссылки подписываются по времени хранилища
// (работает), но время на VDS стоит исправить — от него зависят и сессии.
function showClockSkew(list) {
  if (!list?.length) return;
  const worst = list.reduce((a, b) => (Math.abs(b.offsetSec) > Math.abs(a.offsetSec) ? b : a));
  const min = Math.round(Math.abs(worst.offsetSec) / 60);
  const banner = h('div', { class: 'flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 sm:px-6 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200', role: 'status' },
    icon('clock'),
    h('span', { class: 'flex-1' }, `Часы сервера ${worst.offsetSec > 0 ? 'отстают от' : 'спешат относительно'} хранилища «${worst.storage}» на ${min >= 1 ? `${min} мин` : `${Math.abs(worst.offsetSec)} с`}. Загрузка работает, но время на VDS лучше исправить: sudo timedatectl set-ntp true.`),
    h('button', { type: 'button', class: 'icon-btn h-7 w-7', 'aria-label': 'Скрыть', onclick: () => banner.remove() }, icon('close')));
  $('#storage-banner').after(banner);
}

// ---------- название и логотип ----------
let appName = 'Файлообменник';
function applyBranding(b) {
  if (b?.name) {
    appName = b.name;
    $('#brand-name').textContent = b.name;
    document.title = document.title.replace(/ — .*$/, ` — ${b.name}`);
  }
  $('#brand-logo').src = b?.logo ?? '/favicon.svg';
}
window.addEventListener('fm-branding', (e) => applyBranding(e.detail));

// ---------- левая панель ----------
function initSidebar() {
  const navIcons = { home: ['home', 'Главная'], users: ['users', 'Пользователи'], audit: ['clock', 'Журнал'], shares: ['link', 'Ссылки'], search: ['search', 'Поиск'], trash: ['trash', 'Корзина'], settings: ['settings', 'Настройки'] };
  for (const a of document.querySelectorAll('[data-nav]')) {
    const [ic, label] = navIcons[a.dataset.nav];
    a.replaceChildren(toned(ic), label);
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
// Шкала места внизу левой панели: занято из доступного (квоты хранилищ или личной папки).
function storageMeter(used, total, label) {
  const share = total ? Math.min(1, used / total) : 0;
  const tone = share > 0.95 ? 'bg-rose-500' : share > 0.8 ? 'bg-amber-400' : 'bg-brand-500';
  const fill = h('div', { class: `h-full rounded-full ${tone} transition-[width] duration-500` });
  fill.style.width = `${Math.max(share * 100, used ? 2 : 0)}%`; // CSSOM: inline-стили запрещены CSP
  return h('div', { class: 'space-y-1.5' },
    total ? h('div', { class: 'h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': used, 'aria-label': label }, fill) : null,
    h('p', { class: 'tabular-nums' }, total ? `${label} ${formatSize(used)} из ${formatSize(total)}` : `${label} ${formatSize(used)}`));
}

function refreshStats() {
  clearTimeout(statsTimer);
  if (!ctx.storageConfigured) return;
  statsTimer = setTimeout(async () => {
    try {
      if (ctx.personal?.quotaMb && !ctx.can('admin')) {
        const { personal } = await api.personal();
        if (personal?.used !== null && personal) {
          $('#storage-summary').replaceChildren(storageMeter(personal.used, personal.quotaMb * 1024 * 1024, 'Моя папка:'));
          return;
        }
      }
      const s = await api.stats();
      // Занятое у провайдера (весь бакет, с корзиной) — из суммы квот, если они заданы у всех хранилищ.
      const used = s.storages.reduce((a, x) => a + (x.bucketSize ?? x.size ?? 0), 0);
      const total = s.storages.every((x) => x.quota > 0) ? s.storages.reduce((a, x) => a + x.quota, 0) : 0;
      $('#storage-summary').replaceChildren(storageMeter(used || s.size, total, 'Занято'));
      $('#storage-summary').title = `${pluralize(s.files, FILES)}${s.complete ? '' : '+'}`;
    } catch { /* не критично */ }
  }, 300);
}
// Данные меняют и другие пользователи: обновляем сводку раз в минуту и при возврате на вкладку.
setInterval(() => { if (document.visibilityState === 'visible') refreshStats(); }, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refreshStats();
  current?.refresh?.();
});

// ---------- роутер ----------
let current = null;
let currentRoute = '';

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (raw === 'disk' || raw.startsWith('disk/')) {
    const rest = raw.slice(5);
    // Новый формат: disk/<ID папки>[/<ID файла>]
    const m = /^([0-9a-z]{11}|root)(?:\/([A-Za-z0-9_-]{16}))?$/.exec(rest);
    if (m) return { name: 'disk', id: m[1], folder: pathForId(m[1]), fileId: m[2] };
    // Старый формат (полный путь) — открываем и меняем адрес на короткий.
    let folder = '';
    try {
      folder = rest.split('/').filter(Boolean).map(decodeURIComponent).join('/');
    } catch { /* битый URL — в корень */ }
    folder = folder ? `${folder}/` : '';
    history.replaceState(null, '', diskHash(folder));
    return { name: 'disk', folder };
  }
  if (raw === 'search' || raw.startsWith('search?')) return { name: 'search', params: parseSearchHash(raw), raw };
  return { name: ['users', 'settings', 'audit', 'shares', 'trash', 'inbox'].includes(raw) ? raw : 'home' };
}

function route() {
  let r = parseHash();
  // Папка по ID, которого эта вкладка ещё не знает (ссылка из другого места, новая вкладка) —
  // путь спрашиваем у сервера.
  if (r.name === 'disk' && r.folder === undefined) {
    const hash = location.hash;
    api.folderById(r.id).then(({ path }) => {
      rememberFolderId(r.id, path);
      if (location.hash === hash) route();
    }).catch((err) => {
      toast(err.message, 'error');
      ctx.navigate('#/disk/');
    });
    return;
  }
  if ((r.name === 'users' || r.name === 'audit') && !ctx.can('admin')) r = { name: 'home' };
  if ((r.name === 'shares' || r.name === 'trash') && !ctx.can('editor')) r = { name: 'home' };
  // Смена только ID файла (открыли предпросмотр) — та же страница, не пересоздаём её.
  const id = `${r.name}:${r.folder ?? r.raw ?? ''}`;
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
    current = mountDisk(view, ctx, r.folder, { selectKey, selectId: r.fileId });
  } else if (r.name === 'users') current = mountUsers(view, ctx);
  else if (r.name === 'audit') current = mountAudit(view, ctx);
  else if (r.name === 'shares') current = mountShares(view, ctx);
  else if (r.name === 'trash') current = mountTrash(view, ctx);
  else if (r.name === 'search') current = mountSearch(view, ctx, r.params);
  else if (r.name === 'inbox') current = mountInbox(view, ctx);
  else if (r.name === 'settings') current = mountSettings(view, ctx);
  else current = mountHome(view, ctx);
  const titles = { home: 'Главная', disk: 'Диск', users: 'Пользователи', audit: 'Журнал', shares: 'Ссылки', trash: 'Корзина', search: 'Поиск', inbox: 'Входящие', settings: 'Настройки' };
  document.title = `${titles[r.name]} — ${appName}`;
}

// ---------- загрузки ----------
const queue = [];
let active = 0;
let uploadTarget = '';
let finished = 0;
let failed = 0;
let hideTimer;
let importsActive = 0;

function updateUploadsTitle() {
  updatePauseAll();
  const pending = active + queue.length + importsActive;
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
  files = files.map((it) => (it instanceof File ? { file: it } : it));
  // Продолжение прерванной загрузки — тот же ключ, вопрос про одинаковые имена не нужен.
  files = [...files.filter((it) => it.resume), ...await resolveDuplicates(files.filter((it) => !it.resume), folder)];
  if (!files.length) return;
  clearTimeout(hideTimer);
  if (!active && !queue.length) { finished = 0; failed = 0; clearUploadList(); }
  $('#uploads').classList.remove('hidden');
  for (const item of files) {
    const { file, subfolders = [], replaceKeys, resume } = item;
    const label = [...subfolders, file.name].join(' / ');
    const controller = new AbortController();
    const status = h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400' }, `${formatSize(file.size)} · в очереди`);
    const bar = h('div');
    const cancel = h('button', { type: 'button', class: 'icon-btn h-7 w-7', title: 'Отменить', 'aria-label': `Отменить загрузку ${file.name}` }, icon('close'));
    cancel.onclick = () => controller.abort();
    // Пауза: загруженные части остаются в хранилище, после продолжения догружается остальное.
    const control = new UploadControl();
    const pause = h('button', { type: 'button', class: 'icon-btn h-7 w-7', title: 'Пауза', 'aria-label': `Приостановить ${file.name}`, 'aria-pressed': 'false' }, icon('pause'));
    const entry = { control, pause, status, progress: null };
    pause.onclick = () => togglePause(entry);
    const row = h('li', { class: 'upload-row flex items-center gap-3 px-4 py-3' },
      h('div', { class: 'min-w-0 flex-1' },
        h('div', { class: 'flex items-baseline justify-between gap-3' },
          h('p', { class: 'truncate text-sm font-medium', title: label }, label),
          status),
        h('div', { class: 'progress mt-2' }, bar)),
      pause, cancel);
    $('#upload-list').append(row);
    uploadItems.add(entry);
    queue.push({ file, folder, subfolders: subfolders.length ? subfolders : undefined, replaceKeys, resume, controller, item: entry, ui: { row, status, bar, cancel, pause } });
  }
  updateUploadsTitle();
  pump();
}

// ---------- загрузка по ссылке ----------
// Файл скачивает сервер и потоком кладёт в S3; здесь — диалог и строка в панели загрузок.
async function importFromUrl(folder, url = '') {
  const values = await openDialog({
    title: 'Загрузить по ссылке',
    text: 'Сервер сам скачает файл и положит его в хранилище — компьютер для этого не нужен. Ссылки на внутреннюю сеть запрещены.',
    confirmLabel: 'Загрузить',
    fields: [{ name: 'url', label: 'Ссылка на файл', type: 'url', autocomplete: 'off', maxlength: 4096, value: url }],
    async onSubmit({ url }) {
      if (!/^https?:\/\//i.test(url.trim())) throw new Error('Ссылка должна начинаться с http:// или https://');
      return api.importUrl(url.trim(), folder);
    },
  });
  if (!values?.job) return;
  trackJob(values.job, { folder });
}

// Перенос файла в другое хранилище (байты идут через сервер). Промис — по завершении.
async function transferFile(file, storage) {
  const { job } = await api.transfer(file.key, storage.id);
  return trackJob(job, { kind: 'transfer', oldKey: file.key, label: `${file.name} → ${storage.name}` });
}

// Строка фонового задания (загрузка по ссылке или перенос) в панели загрузок.
function trackJob(job, { folder = '', kind = 'url', oldKey, label } = {}) {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  clearTimeout(hideTimer);
  if (!active && !queue.length && !importsActive) { finished = 0; failed = 0; clearUploadList(); }
  $('#uploads').classList.remove('hidden');
  importsActive++;
  const status = h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400' }, 'подключение…');
  const bar = h('div');
  const title = h('p', { class: 'truncate text-sm font-medium' }, label ?? job.name);
  const what = kind === 'transfer' ? 'перенос в другое хранилище' : kind === 'backup' ? 'резервное копирование' : 'загрузку по ссылке';
  const cancel = h('button', { type: 'button', class: 'icon-btn h-7 w-7', title: 'Отменить', 'aria-label': `Отменить ${what}`, onclick: () => api.jobCancel(job.id).catch(() => {}) }, icon('close'));
  const row = h('li', { class: 'upload-row flex items-center gap-3 px-4 py-3' },
    h('span', { class: 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600 dark:bg-sky-950/60 dark:text-sky-400', title: { transfer: 'Перенос между хранилищами', backup: 'Резервное копирование' }[kind] ?? 'Загрузка по ссылке' }, icon(kind === 'url' ? 'globe' : 'server')),
    h('div', { class: 'min-w-0 flex-1' },
      h('div', { class: 'flex items-baseline justify-between gap-3' }, title, status),
      h('div', { class: 'progress mt-2' }, bar)),
    cancel);
  $('#upload-list').append(row);
  updateUploadsTitle();
  let progress = null;
  const finish = (ok) => {
    importsActive--;
    progress?.finish(ok);
    if (!progress) bar.parentElement.classList.add(ok ? 'is-done' : 'is-error');
    cancel.replaceChildren(icon(ok ? 'check' : 'close'));
    cancel.onclick = () => row.remove();
    cancel.title = 'Скрыть';
    updateUploadsTitle();
    if (ok && !active && !queue.length && !importsActive && !failed) hideTimer = setTimeout(() => { if (!$('#upload-list [data-pending]')) $('#uploads').classList.add('hidden'); }, 4000);
  };
  const poll = async () => {
    let j;
    try {
      ({ job: j } = await api.jobStatus(job.id));
    } catch (err) {
      status.textContent = 'Ошибка';
      settle(null);
      return finish(false);
    }
    title.textContent = label ?? j.name;
    title.title = title.textContent;
    if (j.size && !progress) progress = new ProgressView(bar, status, j.size);
    if (progress) progress.update(j.loaded);
    else if (j.loaded) status.textContent = `${formatSize(j.loaded)} скачано`;
    if (j.status === 'running') return setTimeout(poll, 1000);
    if (j.status === 'done') {
      finished++;
      finish(true);
      status.textContent = 'Готово';
      if (kind === 'transfer') current?.onTransferred?.(oldKey, j.file);
      else if (kind === 'url') current?.onUploaded?.(j.file, j.folder ?? folder);
      refreshStats();
    } else {
      if (j.status === 'cancelled') { finish(false); row.remove(); settle(j); return; }
      failed++;
      finish(false);
      status.textContent = 'Ошибка';
      status.classList.add('text-rose-600');
      toast(`${j.name}: ${j.error}`, 'error');
    }
    settle(j);
  };
  poll();
  return done;
}

// ---------- пауза ----------
const uploadItems = new Set(); // ещё не завершённые загрузки (в очереди и активные)

function setPausedUi(item, paused) {
  item.pause.replaceChildren(icon(paused ? 'play' : 'pause'));
  item.pause.title = paused ? 'Продолжить' : 'Пауза';
  item.pause.setAttribute('aria-pressed', String(paused));
  item.pause.setAttribute('aria-label', item.pause.getAttribute('aria-label').replace(/^(Приостановить|Продолжить)/, paused ? 'Продолжить' : 'Приостановить'));
  if (item.progress) item.progress.setPaused(paused);
  else item.status.textContent = paused ? 'в очереди · пауза' : item.status.textContent.replace(' · пауза', '');
}

function togglePause(item, force) {
  const paused = force ?? !item.control.paused;
  if (paused) item.control.pause(); else item.control.resume();
  setPausedUi(item, paused);
  updatePauseAll();
}

function updatePauseAll() {
  const btn = $('#uploads-pause');
  const list = [...uploadItems];
  btn.classList.toggle('hidden', !list.length);
  const allPaused = list.length > 0 && list.every((i) => i.control.paused);
  btn.replaceChildren(icon(allPaused ? 'play' : 'pause'));
  btn.title = allPaused ? 'Продолжить все' : 'Приостановить все';
  btn.setAttribute('aria-label', btn.title);
  const limit = speedLimit();
  $('#uploads-limit').textContent = limit ? `≤ ${formatSize(limit)}/с` : '';
}

function pump() {
  while (active < FILE_CONCURRENCY && queue.length) {
    active++;
    runUpload(queue.shift()).finally(() => {
      active--;
      updateUploadsTitle();
      if (!active && !queue.length && !importsActive) {
        refreshStats();
        // Всё загрузилось без ошибок — панель прячется сама; при ошибках остаётся.
        if (!failed) hideTimer = setTimeout(() => { if (!$('#upload-list [data-pending]')) $('#uploads').classList.add('hidden'); }, 4000);
      }
      pump();
    });
  }
}

async function runUpload({ file, folder, subfolders, replaceKeys, resume, controller, item, ui }) {
  const { status, bar, row, cancel, pause } = ui;
  if (controller.signal.aborted) { row.remove(); uploadItems.delete(item); return; }
  const progress = new ProgressView(bar, status, file.size);
  item.progress = progress;
  if (item.control.paused) progress.setPaused(true);
  else status.textContent = '0%';
  // Крупный файл (multipart) запоминаем, пока он грузится: после перезагрузки страницы
  // его можно будет продолжить. По завершении (успех, ошибка, отмена) — забываем.
  let pendingKey = resume?.key;
  const done = () => { pause.remove(); uploadItems.delete(item); updatePauseAll(); if (pendingKey) forgetUpload(pendingKey); };
  try {
    const result = await uploadFile(file, {
      folder,
      subfolders,
      resume,
      onPlan: (plan) => { pendingKey = plan.key; rememberUpload(file, plan, folder); },
      control: item.control,
      signal: controller.signal,
      onProgress: (loaded) => progress.update(loaded),
    });
    finished++;
    done();
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
    done();
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

// Новая волна загрузок: старые строки убираем, прерванные (ждут выбора файла) оставляем.
function clearUploadList() {
  for (const row of [...$('#upload-list').children]) if (!row.dataset.pending) row.remove();
}

// ---------- незавершённые загрузки (после перезагрузки страницы) ----------
async function showPendingUploads() {
  const list = pendingUploads();
  if (!list.length || !ctx.can('editor')) return;
  const rows = [];
  for (const rec of list) {
    let parts;
    try {
      ({ parts } = await api.resumeUpload(rec.key, rec.uploadId));
    } catch (err) {
      if (err.status === 410 || err.status === 404 || err.status === 400) forgetUpload(rec.key);
      continue;
    }
    rows.push(pendingRow(rec, parts));
  }
  if (!rows.length) return;
  if (!active && !queue.length && !importsActive) { finished = 0; failed = 0; clearUploadList(); }
  $('#upload-list').append(...rows);
  $('#uploads').classList.remove('hidden');
  $('#uploads-title').textContent = `Не завершено: ${pluralize(rows.length, FILES)}`;
}

function pendingRow(rec, parts) {
  const loaded = parts.reduce((a, p) => a + p.size, 0);
  const pct = rec.size ? Math.floor((loaded / rec.size) * 100) : 0;
  const picker = h('input', { type: 'file', class: 'hidden' });
  const row = h('li', { class: 'upload-row flex items-center gap-3 px-4 py-3', dataset: { pending: rec.key } },
    h('span', { class: 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400', title: 'Прервана' }, icon('pause')),
    h('div', { class: 'min-w-0 flex-1' },
      h('div', { class: 'flex items-baseline justify-between gap-3' },
        h('p', { class: 'truncate text-sm font-medium', title: `${rec.name} → ${folderLabel(rec.folder)}` }, rec.name),
        h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400' }, `${pct}% из ${formatSize(rec.size)}`)),
      h('div', { class: 'mt-1 flex items-center gap-3 text-xs' },
        h('button', { type: 'button', class: 'link font-medium', onclick: () => picker.click() }, 'Продолжить…'),
        h('button', { type: 'button', class: 'text-slate-500 hover:text-rose-600 dark:text-slate-400', onclick: discard }, 'Отменить'))),
    picker);
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file) return;
    if (file.name !== rec.name || file.size !== rec.size) {
      return toast(`Это другой файл: нужен «${rec.name}» (${formatSize(rec.size)})`, 'error');
    }
    if (file.lastModified !== rec.lastModified &&
        !(await confirmDialog('Файл изменён?', 'Дата изменения файла не совпадает с той, что была при начале загрузки. Если содержимое менялось, итоговый файл будет испорчен.', 'Всё равно продолжить'))) return;
    try {
      ({ parts } = await api.resumeUpload(rec.key, rec.uploadId)); // свежий список частей
    } catch (err) {
      forgetUpload(rec.key);
      row.remove();
      return toast(err.message, 'error');
    }
    row.remove();
    enqueue([{ file, resume: { ...rec, done: Object.fromEntries(parts.map((p) => [p.n, p.size])) } }], rec.folder);
  });
  async function discard() {
    if (!(await confirmDialog('Отменить загрузку?', `Уже загруженная часть «${rec.name}» будет удалена из хранилища.`, 'Отменить загрузку'))) return;
    await api.abortUpload(rec.key, rec.uploadId).catch(() => {});
    forgetUpload(rec.key);
    row.remove();
    if (!$('#upload-list').children.length) $('#uploads').classList.add('hidden');
  }
  return row;
}

// ---------- PWA ----------
function initPwa() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('service worker:', err.message));
  // Пришли файлы через «Поделиться», а открыта другая страница — подсказать.
  inboxItems().then((items) => {
    if (items.length && !location.hash.startsWith('#/inbox')) {
      toast(`Во «Входящих»: ${items.length}`, 'info', { action: { label: 'Открыть', onClick: () => ctx.navigate('#/inbox') } });
    }
  }).catch(() => {});
}

// ---------- старт ----------
async function start() {
  try {
    const me = await api.me();
    ctx.user = me.user;
    ctx.storageConfigured = me.storageConfigured;
    ctx.storages = me.storages ?? [];
    ctx.clockSkew = me.clockSkew;
    ctx.trashDays = me.trashDays ?? 0;
    ctx.personal = me.personal;
  } catch {
    return; // при 401 api сам перенаправит на /login
  }
  api.branding().then(applyBranding).catch(() => {});
  initLibrary(ctx.user.username);
  initPending(ctx.user.username);
  showClockSkew(ctx.clockSkew);
  initSidebar();
  initPalette(ctx);
  initPreview(ctx);
  setStorageConfigured(ctx.storageConfigured);
  if (ctx.storageConfigured) showPendingUploads();
  initPwa();

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
  $('#uploads-pause').addEventListener('click', () => {
    const list = [...uploadItems];
    const pauseAll = !list.every((i) => i.control.paused);
    for (const i of list) togglePause(i, pauseAll);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (prefs.get('theme', 'system') === 'system') applyTheme('system');
  });

  window.addEventListener('hashchange', route);
  route();
  refreshStats();
}

start();
