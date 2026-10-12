// Оболочка приложения: роутер (#/...), левая панель (навигация + дерево диска),
// заголовок страницы, очередь загрузок. Разделы — в ./views/*.
import { api } from './api.js';
import { initPreview } from './preview.js';
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
  enqueue,
  refreshStats,
  selectAfterNavigate: null,
  newFolderHere: null,
};

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

  tree.initTree($('#tree'), (path) => ctx.navigate(diskHash(path)));
}

let statsTimer;
function refreshStats() {
  clearTimeout(statsTimer);
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

function enqueue(files, folder) {
  if (!ctx.can('editor')) return toast('Недостаточно прав для загрузки', 'error');
  clearTimeout(hideTimer);
  if (!active && !queue.length) { finished = 0; failed = 0; $('#upload-list').replaceChildren(); }
  $('#uploads').classList.remove('hidden');
  for (const file of files) {
    const controller = new AbortController();
    const status = h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400' }, `${formatSize(file.size)} · в очереди`);
    const bar = h('div', { class: 'w-0' });
    const cancel = h('button', { type: 'button', class: 'icon-btn h-7 w-7', title: 'Отменить', 'aria-label': `Отменить загрузку ${file.name}` }, icon('close'));
    cancel.onclick = () => controller.abort();
    const row = h('li', { class: 'flex items-center gap-3 px-4 py-3' },
      h('div', { class: 'min-w-0 flex-1' },
        h('div', { class: 'flex items-baseline justify-between gap-3' },
          h('p', { class: 'truncate text-sm font-medium', title: file.name }, file.name),
          status),
        h('div', { class: 'progress mt-2' }, bar)),
      cancel);
    $('#upload-list').append(row);
    queue.push({ file, folder, controller, ui: { row, status, bar, cancel } });
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

async function runUpload({ file, folder, controller, ui }) {
  const { status, bar, row, cancel } = ui;
  if (controller.signal.aborted) { row.remove(); return; }
  const started = performance.now();
  try {
    const result = await uploadFile(file, {
      folder,
      signal: controller.signal,
      onProgress(loaded, total) {
        const pct = total ? Math.min(100, (loaded / total) * 100) : 100;
        bar.style.width = `${pct}%`; // CSSOM разрешён CSP, в отличие от inline style
        const seconds = (performance.now() - started) / 1000;
        const speed = seconds > 0.5 ? ` · ${formatSize(loaded / seconds)}/с` : '';
        status.textContent = `${Math.floor(pct)}%${speed}`;
      },
    });
    finished++;
    bar.style.width = '100%';
    status.textContent = 'Готово';
    cancel.replaceChildren(icon('check'));
    cancel.disabled = true;
    current?.onUploaded?.(result, folder);
  } catch (err) {
    if (err instanceof UploadCancelled) { row.remove(); return; }
    failed++;
    bar.classList.add('!bg-rose-500');
    bar.style.width = '100%';
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
    ({ user: ctx.user } = await api.me());
  } catch {
    return; // при 401 api сам перенаправит на /login
  }
  initSidebar();
  initPreview(ctx);

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
