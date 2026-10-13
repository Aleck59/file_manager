// Раздел «Поиск»: по всему диску — по имени, типу файла и цветной метке.
// Адрес: #/search?q=…&category=image&label=red — можно добавить в закладки.
import { api } from '../api.js';
import { LABELS, labelDot } from '../labels.js';
import { FILES, fileBadge, folderLabel, formatDate, formatDateShort, formatSize, h, icon, pluralize, toast } from '../ui.js';
import { diskHash } from './disk.js';

const CATEGORIES = [
  ['', 'Все типы'], ['image', 'Изображения'], ['video', 'Видео'], ['audio', 'Аудио'],
  ['document', 'Документы'], ['archive', 'Архивы'], ['other', 'Другое'],
];

export function searchHash(params = {}) {
  const usp = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return `#/search${usp.toString() ? `?${usp}` : ''}`;
}

export function parseSearchHash(raw) {
  const i = raw.indexOf('?');
  const usp = new URLSearchParams(i >= 0 ? raw.slice(i + 1) : '');
  return { q: usp.get('q') ?? '', category: usp.get('category') ?? '', label: usp.get('label') ?? '' };
}

export function mountSearch(view, ctx, params) {
  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Поиск по диску'), []);
  const state = { ...params };
  let seq = 0;

  const input = h('input', { type: 'search', class: 'input pl-10', placeholder: 'Имя файла или папки', value: state.q, 'aria-label': 'Что искать', maxlength: 200, enterkeyhint: 'search' });
  const category = h('select', { class: 'select', 'aria-label': 'Тип файла' },
    CATEGORIES.map(([v, l]) => h('option', { value: v, selected: v === state.category }, l)));
  const chip = (value, label, dot) => h('button', {
    type: 'button', class: 'label-chip', 'aria-pressed': String(state.label === value), dataset: { label: value },
    onclick: () => { state.label = state.label === value ? '' : value; syncChips(); run(); },
  }, dot, label);
  const chips = h('div', { class: 'flex flex-wrap items-center gap-1.5', role: 'group', 'aria-label': 'Метка' },
    ...LABELS.map(([id, name]) => chip(id, name, labelDot(id))));
  const syncChips = () => { for (const b of chips.children) b.setAttribute('aria-pressed', String(b.dataset.label === state.label)); };
  const status = h('p', { class: 'text-sm text-slate-500 dark:text-slate-400', role: 'status' });
  const results = h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' });
  const resultsCard = h('section', { class: 'card hidden overflow-hidden' }, results);

  const form = h('form', { class: 'card space-y-3 p-4', role: 'search' },
    h('div', { class: 'flex flex-col gap-2 sm:flex-row' },
      h('div', { class: 'relative min-w-0 flex-1' },
        h('span', { class: 'pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400' }, icon('search')), input),
      h('div', { class: 'flex gap-2' }, category, h('button', { type: 'submit', class: 'btn-primary' }, 'Найти'))),
    chips);
  form.addEventListener('submit', (e) => { e.preventDefault(); state.q = input.value.trim(); run(); });
  category.addEventListener('change', () => { state.category = category.value; run(); });

  view.replaceChildren(h('div', { class: 'mx-auto max-w-5xl space-y-4 p-4 sm:p-6' }, form, status, resultsCard));

  const open = (f) => { ctx.selectAfterNavigate = f.key; ctx.navigate(diskHash(f.folder)); };
  const folderRow = (f) => h('li', {},
    h('a', { href: diskHash(f.path), class: 'flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60' },
      h('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400' }, icon('folder')),
      h('span', { class: 'min-w-0 flex-1' },
        h('span', { class: 'flex items-center gap-2' }, h('span', { class: 'truncate text-sm font-medium' }, f.name), labelDot(f.label)),
        h('span', { class: 'block truncate text-xs text-slate-500 dark:text-slate-400' }, folderLabel(f.path)))));
  const fileRow = (f) => h('li', {},
    h('button', { type: 'button', class: 'flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60', onclick: () => open(f) },
      fileBadge(f.name),
      h('span', { class: 'min-w-0 flex-1' },
        h('span', { class: 'flex items-center gap-2' }, h('span', { class: 'truncate text-sm font-medium' }, f.name), labelDot(f.label)),
        h('span', { class: 'block truncate text-xs text-slate-500 dark:text-slate-400' }, folderLabel(f.folder))),
      h('span', { class: 'hidden shrink-0 text-right text-xs tabular-nums text-slate-500 sm:block dark:text-slate-400', title: formatDate(f.lastModified) },
        h('span', { class: 'block' }, formatSize(f.size)), h('span', { class: 'block' }, formatDateShort(f.lastModified, { time: false })))));

  async function run() {
    const params = { q: state.q, category: state.category, label: state.label };
    history.replaceState(null, '', searchHash(params));
    if (!state.q && !state.category && !state.label) {
      status.textContent = 'Введите часть имени, выберите тип или метку.';
      resultsCard.classList.add('hidden');
      return;
    }
    const my = ++seq;
    status.textContent = 'Ищу…';
    try {
      const r = await api.search(params);
      if (my !== seq) return;
      const total = r.files.length + r.folders.length;
      status.textContent = total
        ? `${r.folders.length ? `${pluralize(r.folders.length, { one: 'папка', few: 'папки', many: 'папок', other: 'папки' })}, ` : ''}${pluralize(r.files.length, FILES)}${r.truncated ? ' — показаны первые, уточните запрос' : ''}`
        : 'Ничего не найдено';
      if (r.warnings?.length) status.textContent += ` · недоступно: ${r.warnings.map((w) => w.storage).join(', ')}`;
      results.replaceChildren(...r.folders.map(folderRow), ...r.files.map(fileRow));
      resultsCard.classList.toggle('hidden', !total);
    } catch (err) {
      if (my !== seq) return;
      status.textContent = '';
      toast(err.message, 'error');
    }
  }

  run();
  if (!state.q) input.focus();
  return { unmount() { seq++; } };
}
