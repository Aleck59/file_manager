// Общие помощники интерфейса: создание элементов, форматирование, иконки,
// уведомления и модальные окна. Пользовательские данные выводятся только
// через textContent — HTML из данных никогда не вставляется.

export const $ = (sel, root = document) => root.querySelector(sel);

/** h('div', {class: 'x', onclick}, child1, 'text', ...) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// ---------- иконки (статичные SVG, в стиле Lucide) ----------
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  drive: '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderPlus: '<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  upload: '<path d="M12 13v8"/><path d="m8 17 4-4 4 4"/><path d="M20.4 15.6A5 5 0 0 0 18 6h-1.3A8 8 0 1 0 4 14.3"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  video: '<path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h8M8 17h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  move: '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  sort: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
  folderUp: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 17v-6"/><path d="m9 14 3-3 3 3"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  star: '<path d="M11.5 2.9a.6.6 0 0 1 1 0l2.6 5.4 5.9.9a.6.6 0 0 1 .3 1l-4.3 4.2 1 5.9a.6.6 0 0 1-.8.6L12 18.1l-5.3 2.8a.6.6 0 0 1-.8-.6l1-5.9-4.3-4.2a.6.6 0 0 1 .3-1l5.9-.9Z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  qr: '<rect width="6" height="6" x="3" y="3" rx="1"/><rect width="6" height="6" x="15" y="3" rx="1"/><rect width="6" height="6" x="3" y="15" rx="1"/><path d="M15 15h2v2h-2zM19 19h2v2h-2zM15 19h2M19 15h2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>',
  token: '<path d="M2.5 18.5A2 2 0 0 0 4.5 21h15a2 2 0 0 0 2-2.5"/><rect width="18" height="12" x="3" y="3" rx="2"/><path d="M7 9h.01M11 9h6"/>',
};

// Тип данных для перетаскивания файлов внутри приложения (не путать с файлами с компьютера).
export const DRAG_TYPE = 'application/x-fm-file';

// Делает элемент целью для перетаскивания файла из списка (подсвечивается при наведении).
export function makeDropTarget(el, onDrop) {
  let depth = 0;
  const accepts = (e) => [...(e.dataTransfer?.types ?? [])].includes(DRAG_TYPE);
  const reset = () => { depth = 0; el.classList.remove('drop-target'); };
  el.addEventListener('dragenter', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    depth++;
    el.classList.add('drop-target');
  });
  el.addEventListener('dragover', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  el.addEventListener('dragleave', (e) => {
    if (accepts(e) && --depth <= 0) reset();
  });
  el.addEventListener('drop', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    reset();
    onDrop(e.dataTransfer.getData(DRAG_TYPE));
  });
}

export function icon(name, cls = 'h-4 w-4') {
  const span = document.createElement('span');
  span.className = 'inline-flex shrink-0';
  span.setAttribute('aria-hidden', 'true');
  // Строки ICONS — статичные константы этого модуля, не пользовательские данные.
  span.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.file}</svg>`;
  return span;
}

// ---------- форматирование ----------
const sizeFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
// Цветные иконки: у каждого действия свой цвет — легче находить глазами.
// Полные имена классов (Tailwind собирает стили по исходникам).
const ICON_TONE = {
  home: 'text-sky-600 dark:text-sky-400', search: 'text-violet-600 dark:text-violet-400', link: 'text-violet-600 dark:text-violet-400',
  trash: 'text-rose-600 dark:text-rose-400', users: 'text-indigo-600 dark:text-indigo-400', clock: 'text-orange-500 dark:text-orange-400',
  settings: 'text-slate-500 dark:text-slate-400', download: 'text-sky-600 dark:text-sky-400', globe: 'text-teal-600 dark:text-teal-400',
  qr: 'text-indigo-600 dark:text-indigo-400', pencil: 'text-amber-600 dark:text-amber-400', move: 'text-indigo-600 dark:text-indigo-400',
  copy: 'text-cyan-600 dark:text-cyan-400', server: 'text-slate-500 dark:text-slate-400', star: 'text-amber-500 dark:text-amber-400',
  check: 'text-emerald-600 dark:text-emerald-400', folder: 'text-amber-500 dark:text-amber-400', folderPlus: 'text-amber-500 dark:text-amber-400',
  folderUp: 'text-amber-500 dark:text-amber-400', tag: 'text-pink-600 dark:text-pink-400', lock: 'text-amber-600 dark:text-amber-400',
  user: 'text-sky-600 dark:text-sky-400', eye: 'text-teal-600 dark:text-teal-400', refresh: 'text-emerald-600 dark:text-emerald-400',
  key: 'text-amber-600 dark:text-amber-400', shield: 'text-emerald-600 dark:text-emerald-400', undo: 'text-emerald-600 dark:text-emerald-400',
  upload: 'text-brand-600 dark:text-brand-400', drive: 'text-brand-600 dark:text-brand-400', chart: 'text-sky-600 dark:text-sky-400',
  keyboard: 'text-slate-500 dark:text-slate-400', file: 'text-slate-500 dark:text-slate-400',
};
/** Иконка в своём цвете (для меню, панелей действий, навигации). */
export const toned = (name, cls = 'h-4 w-4') => icon(name, `${cls} ${ICON_TONE[name] ?? ''}`);

export function formatSize(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${sizeFmt.format(n)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const formatDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');

// Короткая дата для списков: «сегодня, 18:56», «вчера, 09:10», «12 окт., 18:56», «3 мар. 2025».
// Полная дата остаётся в подсказке (title). Читается быстрее и не переносится на телефоне.
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const dayYearFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
export function formatDateShort(iso, { time = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  const at = time ? `, ${timeFmt.format(d)}` : '';
  if (days === 0) return `сегодня${at}`;
  if (days === 1) return `вчера${at}`;
  if (d.getFullYear() === now.getFullYear()) return `${dayFmt.format(d)}${at}`;
  return dayYearFmt.format(d).replace(/\s*г\.$/, '');
}

const plural = new Intl.PluralRules('ru-RU');
export function pluralize(n, forms) {
  return `${n.toLocaleString('ru-RU')} ${forms[plural.select(n)] ?? forms.other}`;
}
export const FILES = { one: 'файл', few: 'файла', many: 'файлов', other: 'файла' };
export const FOLDERS = { one: 'папка', few: 'папки', many: 'папок', other: 'папки' };
export const USERS = { one: 'пользователь', few: 'пользователя', many: 'пользователей', other: 'пользователя' };

export function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1).toLowerCase() : '';
}

const CATEGORY_EXT = {
  image: 'png jpg jpeg gif webp avif bmp ico svg heic tiff',
  video: 'mp4 m4v webm ogv mov mkv avi',
  audio: 'mp3 wav ogg oga m4a aac flac opus',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst',
  document: 'pdf txt md csv json xml yml yaml doc docx xls xlsx ppt pptx odt ods odp rtf html css js ts py log',
};
export function categoryOf(name) {
  const ext = extOf(name);
  for (const [cat, list] of Object.entries(CATEGORY_EXT)) if (list.split(' ').includes(ext)) return cat;
  return 'other';
}

// Визуальный стиль типа файла (иконка + тон). Цвет здесь — вторичный признак,
// тип всегда продублирован расширением/иконкой.
export const CATEGORY_STYLE = {
  image: { icon: 'image', tone: 'bg-sky-50 text-sky-600 dark:bg-sky-950/60 dark:text-sky-400' },
  video: { icon: 'video', tone: 'bg-orange-50 text-orange-600 dark:bg-orange-950/60 dark:text-orange-400' },
  audio: { icon: 'music', tone: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400' },
  document: { icon: 'doc', tone: 'bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400' },
  archive: { icon: 'archive', tone: 'bg-pink-50 text-pink-600 dark:bg-pink-950/60 dark:text-pink-400' },
  other: { icon: 'file', tone: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
};

export function fileBadge(name, size = 'h-9 w-9 rounded-lg', iconSize = 'h-4 w-4') {
  const style = CATEGORY_STYLE[categoryOf(name)];
  return h('span', { class: `flex ${size} shrink-0 items-center justify-center ${style.tone}` }, icon(style.icon, iconSize));
}

// Человекочитаемая папка: "" → «Мой диск», "a/b/" → «Мой диск / a / b»
// Корень диска пользователя: у кого личная папка — она, у остальных весь диск ('').
export let homeFolder = '';
export function setHomeFolder(path) { homeFolder = path || ''; }

export function folderLabel(folder) {
  const rest = folder.startsWith(homeFolder) ? folder.slice(homeFolder.length) : folder;
  return ['Мой диск', ...rest.split('/').filter(Boolean)].join(' / ');
}

// «Chrome · Windows» из User-Agent — для журнала и списка сессий.
export function describeUA(ua = '') {
  const browser = /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari'
      : /curl\//i.test(ua) ? 'curl' : ua ? 'Другой браузер' : 'Неизвестно';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

// ---------- уведомления ----------
/**
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 * @param {{action?: {label: string, onClick: () => void}}} [opts] — кнопка в уведомлении («Отменить», «Открыть»)
 */
export function toast(message, type = 'info', { action } = {}) {
  const palette = {
    info: 'bg-slate-900 text-white dark:bg-white dark:text-slate-900',
    success: 'bg-brand-700 text-white',
    error: 'bg-rose-600 text-white',
  };
  const el = h('div', {
    class: `pointer-events-auto flex max-w-md animate-toast-in items-center gap-3 rounded-xl px-4 py-2.5 text-sm shadow-lg ${palette[type]}`,
    role: type === 'error' ? 'alert' : 'status',
  }, h('span', { class: 'min-w-0 flex-1' }, message),
  action && h('button', {
    type: 'button',
    class: 'shrink-0 rounded-md px-2 py-0.5 font-semibold underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-current',
    onclick: () => { el.remove(); action.onClick(); },
  }, action.label));
  $('#toasts').append(el);
  setTimeout(() => el.remove(), action ? 8000 : type === 'error' ? 6000 : 3000);
}

// ---------- модальные окна ----------
/**
 * Универсальный диалог на <dialog>. fields: [{name, label, type, value, options, autocomplete, hint}]
 * Возвращает объект значений или null при отмене. onSubmit может бросить ошибку — она
 * покажется в окне, и окно останется открытым.
 */
export function openDialog({ title, text, fields = [], confirmLabel = 'OK', danger = false, onSubmit }) {
  return new Promise((resolve) => {
    const error = h('p', { class: 'hidden rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', role: 'alert' });
    const inputs = fields.map((f) => {
      const id = `dlg-${f.name}`;
      if (f.type === 'checkbox') {
        return h('label', { for: id, class: 'flex items-start gap-3 text-sm' },
          h('input', { id, name: f.name, type: 'checkbox', class: 'check mt-0.5', checked: Boolean(f.value) }),
          h('span', {}, h('span', { class: 'block font-medium' }, f.label), f.hint && h('span', { class: 'block text-xs text-slate-500 dark:text-slate-400' }, f.hint)));
      }
      const control = f.type === 'select'
        ? h('select', { id, name: f.name, class: 'input' }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)))
        : h('input', { id, name: f.name, type: f.type ?? 'text', class: 'input', value: f.value ?? '',
          autocomplete: f.autocomplete ?? 'off', required: !f.optional, maxlength: f.maxlength ?? 256, inputmode: f.inputmode, placeholder: f.placeholder });
      return h('div', {},
        h('label', { for: id, class: 'mb-1.5 block text-sm font-medium' }, f.label),
        control,
        f.hint && h('p', { class: 'mt-1 text-xs text-slate-500 dark:text-slate-400' }, f.hint));
    });
    const submit = h('button', { type: 'submit', class: danger ? 'btn-danger' : 'btn-primary' }, confirmLabel);
    const form = h('form', { class: 'space-y-4 p-6', novalidate: true },
      h('h3', { class: 'text-lg font-semibold' }, title),
      text && h('p', { class: 'break-words text-sm text-slate-500 dark:text-slate-400' }, text),
      ...inputs,
      error,
      h('div', { class: 'flex justify-end gap-2 pt-2' },
        h('button', { type: 'button', class: 'btn-ghost', onclick: () => dialog.close() }, 'Отмена'),
        submit));
    const dialog = h('dialog', { class: 'w-[min(28rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' }, form);
    let result = null;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      for (const f of fields) if (f.type === 'checkbox') values[f.name] = form.elements[f.name].checked;
      error.classList.add('hidden');
      submit.disabled = true;
      try {
        result = onSubmit ? (await onSubmit(values)) ?? values : values;
        dialog.close();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      } finally {
        submit.disabled = false;
      }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    const first = form.querySelector('input, select') ?? submit;
    first.focus();
    // Например, при переименовании выделяем имя без расширения.
    if (fields[0]?.select && first.setSelectionRange) first.setSelectionRange(...fields[0].select);
  });
}

// ---------- выпадающее меню ----------
let closeOpenMenu = null;

/** items: [{label, icon, onSelect, danger}] — меню у кнопки anchor, закрывается кликом вне/Esc. */
// Пункт {more: [...]} — «Ещё»: открывает остальные действия на том же месте.
export function openMenu(anchor, items) {
  closeOpenMenu?.();
  items = items.filter(Boolean).map((item) => {
    if (!item.more) return item;
    const rest = item.more.filter(Boolean);
    return rest.length ? { label: item.label ?? 'Ещё', icon: item.icon ?? 'more', onSelect: () => openMenu(anchor, rest) } : null;
  });
  const menu = h('div', {
    class: 'fixed z-[55] min-w-[12rem] rounded-xl border border-slate-200 bg-white p-1 shadow-xl animate-toast-in dark:border-slate-700 dark:bg-slate-900',
    role: 'menu',
  }, items.filter(Boolean).map((item) => h('button', {
    type: 'button', role: 'menuitem',
    class: `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition ${item.danger
      ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950'
      : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`,
    onclick: (e) => { e.stopPropagation(); close(); item.onSelect(); },
  }, item.lead ?? (item.danger ? icon(item.icon) : toned(item.icon)), item.label)));
  document.body.append(menu);

  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 4 + menu.offsetHeight > window.innerHeight ? r.top - menu.offsetHeight - 4 : r.bottom + 4;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const buttons = [...menu.querySelectorAll('button')];
  buttons[0]?.focus();
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
    if (e.key === 'Tab') close();
  };
  const onOutside = (e) => { if (!menu.contains(e.target)) close(); };
  function close() {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', close, true);
    closeOpenMenu = null;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);
  closeOpenMenu = close;
}

export const confirmDialog = (title, text, confirmLabel = 'Удалить') =>
  openDialog({ title, text, confirmLabel, danger: true }).then(Boolean);

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { readonly: true, class: 'fixed -left-[9999px]' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Не удалось скопировать ссылку');
  }
}

// ---------- локальные настройки интерфейса ----------
export const prefs = {
  get(key, fallback) {
    try { return localStorage.getItem(`fm-${key}`) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`fm-${key}`, value); } catch { /* приватный режим */ }
  },
};

export function applyTheme(pref = prefs.get('theme', 'system')) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
