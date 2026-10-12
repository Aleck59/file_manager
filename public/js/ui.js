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
};

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
export function formatSize(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${sizeFmt.format(n)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const formatDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');

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

export function fileBadge(name, size = 'h-9 w-9') {
  const style = CATEGORY_STYLE[categoryOf(name)];
  return h('span', { class: `flex ${size} shrink-0 items-center justify-center rounded-lg ${style.tone}` }, icon(style.icon));
}

// Человекочитаемая папка: "" → «Мой диск», "a/b/" → «Мой диск / a / b»
export function folderLabel(folder) {
  return ['Мой диск', ...folder.split('/').filter(Boolean)].join(' / ');
}

// ---------- уведомления ----------
export function toast(message, type = 'info') {
  const palette = {
    info: 'bg-slate-900 text-white dark:bg-white dark:text-slate-900',
    success: 'bg-brand-700 text-white',
    error: 'bg-rose-600 text-white',
  };
  const el = h('div', {
    class: `pointer-events-auto max-w-md animate-toast-in rounded-xl px-4 py-2.5 text-sm shadow-lg ${palette[type]}`,
    role: type === 'error' ? 'alert' : 'status',
  }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
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
      const control = f.type === 'select'
        ? h('select', { id, name: f.name, class: 'input' }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)))
        : h('input', { id, name: f.name, type: f.type ?? 'text', class: 'input', value: f.value ?? '',
          autocomplete: f.autocomplete ?? 'off', required: true, maxlength: f.maxlength ?? 256 });
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
    (form.querySelector('input, select') ?? submit).focus();
  });
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
