// Командная палитра (Ctrl+K / ⌘K): быстрый переход к странице, папке, избранному или
// недавнему файлу и частые действия — всё одним поиском с клавиатуры.
import { favorites, recentFiles } from './library.js';
import { knownFolders } from './tree.js';
import { $, applyTheme, folderLabel, h, icon, prefs } from './ui.js';
import { diskHash } from './views/disk.js';

let openDialogEl = null;

// Совпадение без учёта регистра и «ё»; выше — совпадения в начале слова.
const norm = (s) => s.toLowerCase().replaceAll('ё', 'е');
function score(text, query) {
  if (!query) return 1;
  const t = norm(text);
  const i = t.indexOf(query);
  if (i < 0) return 0;
  return i === 0 ? 3 : /[\s/_\-.(]/.test(t[i - 1]) ? 2 : 1;
}

export function openPalette(ctx) {
  if (openDialogEl) return;
  const commands = buildCommands(ctx);
  const input = h('input', {
    type: 'text', class: 'w-full bg-transparent py-3.5 pl-11 pr-4 text-base outline-none placeholder:text-slate-400',
    placeholder: 'Папка, файл, страница или действие…', 'aria-label': 'Команда или поиск',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', autocomplete: 'off', spellcheck: 'false',
  });
  const list = h('ul', { id: 'palette-list', role: 'listbox', class: 'max-h-[min(24rem,60vh)] overflow-y-auto p-1.5' });
  const dialog = h('dialog', { class: 'palette mt-[12vh] w-[min(36rem,calc(100%-2rem))] overflow-hidden rounded-2xl bg-white p-0 text-slate-800 shadow-2xl dark:bg-slate-900 dark:text-slate-200', 'aria-label': 'Командная палитра' },
    h('div', { class: 'relative border-b border-slate-200 dark:border-slate-800' },
      h('span', { class: 'pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400' }, icon('search')), input),
    list,
    h('div', { class: 'flex items-center gap-3 border-t border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400' },
      h('span', {}, h('kbd', { class: 'kbd' }, '↑↓'), ' выбор'), h('span', {}, h('kbd', { class: 'kbd' }, 'Enter'), ' открыть'), h('span', {}, h('kbd', { class: 'kbd' }, 'Esc'), ' закрыть')));

  let shown = [];
  let active = 0;
  function render() {
    const q = norm(input.value.trim());
    shown = commands
      .map((c) => ({ c, s: Math.max(score(c.title, q), c.hint ? score(c.hint, q) * 0.5 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.c.order - b.c.order)
      .slice(0, 50)
      .map((x) => x.c);
    active = Math.min(active, Math.max(0, shown.length - 1));
    let lastGroup = '';
    const items = [];
    shown.forEach((c, i) => {
      if (c.group !== lastGroup) {
        lastGroup = c.group;
        items.push(h('li', { role: 'presentation', class: 'px-3 pb-1 pt-2.5 text-xs font-medium uppercase tracking-wide text-slate-400' }, c.group));
      }
      items.push(h('li', {
        id: `pal-${i}`, role: 'option', 'aria-selected': String(i === active),
        class: 'palette-item flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm',
        onmousemove: () => { if (active !== i) { active = i; mark(); } },
        onclick: () => run(c),
      },
      h('span', { class: 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }, icon(c.icon)),
      h('span', { class: 'min-w-0 flex-1' },
        h('span', { class: 'block truncate' }, c.title),
        c.hint && h('span', { class: 'block truncate text-xs text-slate-500 dark:text-slate-400' }, c.hint))));
    });
    if (!shown.length) items.push(h('li', { class: 'px-3 py-8 text-center text-sm text-slate-500' }, 'Ничего не найдено'));
    list.replaceChildren(...items);
    mark();
  }
  function mark() {
    for (const el of list.querySelectorAll('[role=option]')) el.setAttribute('aria-selected', String(el.id === `pal-${active}`));
    input.setAttribute('aria-activedescendant', shown.length ? `pal-${active}` : '');
    list.querySelector(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
  }
  function run(c) {
    dialog.close();
    c.run();
  }

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      mark();
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault();
      run(shown[active]);
    }
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove(); openDialogEl = null; });
  document.body.append(dialog);
  openDialogEl = dialog;
  dialog.showModal();
  render();
  input.focus();
}

function buildCommands(ctx) {
  const out = [];
  let order = 0;
  const add = (group, title, ic, run, hint) => out.push({ group, title, icon: ic, run, hint, order: order++ });
  const openFile = (f) => { ctx.selectAfterNavigate = f.key; ctx.navigate(diskHash(f.folder)); };

  add('Переход', 'Главная', 'home', () => ctx.navigate('#/'));
  add('Переход', 'Мой диск', 'drive', () => ctx.navigate(diskHash('')));
  if (ctx.can('admin')) add('Переход', 'Пользователи', 'users', () => ctx.navigate('#/users'));
  add('Переход', 'Настройки', 'settings', () => ctx.navigate('#/settings'));
  if (ctx.can('admin')) add('Переход', 'Журнал действий', 'clock', () => ctx.navigate('#/audit'));

  for (const f of favorites()) {
    if (f.type === 'folder') add('Избранное', f.name, 'folder', () => ctx.navigate(diskHash(f.path)), folderLabel(f.path));
    else add('Избранное', f.name, 'file', () => openFile(f), folderLabel(f.folder));
  }
  for (const f of recentFiles()) add('Недавно открытые', f.name, 'clock', () => openFile(f), folderLabel(f.folder));
  const favFolders = new Set(favorites().filter((f) => f.type === 'folder').map((f) => f.path));
  for (const f of knownFolders().filter((x) => !favFolders.has(x.path)).sort((a, b) => a.path.localeCompare(b.path, 'ru'))) {
    add('Папки', f.name, 'folder', () => ctx.navigate(diskHash(f.path)), folderLabel(f.path));
  }

  if (ctx.can('editor') && ctx.storageConfigured) {
    const here = ctx.currentFolder?.() ?? '';
    add('Действия', 'Загрузить файлы', 'upload', () => ctx.pickFiles(here), `в «${folderLabel(here)}»`);
    add('Действия', 'Загрузить папку', 'folderUp', () => ctx.pickFolder(here), `в «${folderLabel(here)}»`);
    add('Действия', 'Новая папка', 'folderPlus', () => {
      if (ctx.newFolderHere) ctx.newFolderHere();
      else { ctx.navigate(diskHash('')); setTimeout(() => ctx.newFolderHere?.(), 0); }
    });
  }
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  add('Действия', theme === 'dark' ? 'Тёмная тема' : 'Светлая тема', 'eye', () => { prefs.set('theme', theme); applyTheme(theme); });
  add('Действия', 'Горячие клавиши', 'keyboard', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })), 'на странице диска');
  return out;
}

/** Ctrl+K / ⌘K в любом месте приложения. */
export function initPalette(ctx) {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette(ctx);
    }
  });
  $('#palette-open')?.addEventListener('click', () => openPalette(ctx));
}
