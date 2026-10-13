// Раздел «Главная»: сводка по диску, структура хранилища по типам и недавние файлы.
import { api } from '../api.js';
import { recentFiles } from '../library.js';
import { thumbnail } from '../thumbs.js';
import { $, FILES, folderLabel, formatDate, formatDateShort, formatSize, h, icon, pluralize, toast } from '../ui.js';
import { diskHash, storageNotice } from './disk.js';

// Категориальная палитра (проверена валидатором dataviz для светлой и тёмной темы):
// порядок фиксирован, «Прочее» — нейтральный серый. Цвет дублируется подписями в легенде.
const CATEGORIES = [
  { id: 'image', label: 'Изображения', cls: 'bg-[#2a78d6] dark:bg-[#3987e5]' },
  { id: 'video', label: 'Видео', cls: 'bg-[#eb6834] dark:bg-[#d95926]' },
  { id: 'audio', label: 'Аудио', cls: 'bg-[#1baf7a] dark:bg-[#199e70]' },
  { id: 'document', label: 'Документы', cls: 'bg-[#eda100] dark:bg-[#c98500]' },
  { id: 'archive', label: 'Архивы', cls: 'bg-[#e87ba4] dark:bg-[#d55181]' },
  { id: 'other', label: 'Прочее', cls: 'bg-slate-400 dark:bg-slate-500' },
];

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Доброй ночи';
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}

function statTile(label, value, sub, iconName) {
  return h('div', { class: 'card p-5' },
    h('div', { class: 'flex items-center justify-between' },
      h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, label),
      h('span', { class: 'text-slate-400' }, icon(iconName))),
    h('p', { class: 'mt-2 text-2xl font-semibold tracking-tight tabular-nums' }, value),
    sub && h('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400' }, sub));
}

// Подсказка при наведении на сегмент полосы.
function attachTooltip(el, lines) {
  const tip = $('#chart-tooltip');
  const move = (e) => {
    tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY - tip.offsetHeight - 10}px`;
  };
  el.addEventListener('pointerenter', (e) => {
    tip.replaceChildren(...lines.map((l, i) => h('div', { class: i ? 'opacity-80' : 'font-medium' }, l)));
    tip.classList.remove('hidden');
    move(e);
  });
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerleave', () => tip.classList.add('hidden'));
}

function breakdown(stats) {
  const used = CATEGORIES.map((c) => ({ ...c, ...stats.categories[c.id] })).filter((c) => c.count > 0);
  if (!used.length) {
    return h('p', { class: 'py-6 text-center text-sm text-slate-500 dark:text-slate-400' }, 'Пока нет данных — загрузите первые файлы.');
  }
  const total = stats.size || 1;
  const pct = (size) => (size / total) * 100;
  const fmtPct = (size) => `${pct(size) < 1 && size > 0 ? '<1' : Math.round(pct(size))}%`;

  // Полоса «часть целого»: сегменты с зазором 2px, скруглённые края, подсказка при наведении.
  const bar = h('div', { class: 'flex h-3 w-full gap-[2px] overflow-hidden rounded', role: 'img',
    'aria-label': `Структура хранилища: ${used.map((c) => `${c.label} ${fmtPct(c.size)}`).join(', ')}` });
  for (const c of used) {
    const seg = h('div', { class: `h-full min-w-[4px] first:rounded-l last:rounded-r ${c.cls}` });
    seg.style.flexGrow = String(Math.max(c.size, total * 0.004));
    seg.style.flexBasis = '0';
    attachTooltip(seg, [c.label, `${formatSize(c.size)} · ${fmtPct(c.size)}`, pluralize(c.count, FILES)]);
    bar.append(seg);
  }

  // Легенда-таблица: идентичность никогда не передаётся только цветом.
  const legend = h('table', { class: 'mt-5 w-full text-sm' },
    h('thead', { class: 'sr-only' }, h('tr', {}, h('th', {}, 'Тип'), h('th', {}, 'Файлов'), h('th', {}, 'Размер'), h('th', {}, 'Доля'))),
    h('tbody', {}, used.map((c) => h('tr', { class: 'border-t border-slate-100 first:border-0 dark:border-slate-800' },
      h('td', { class: 'py-2' }, h('span', { class: 'flex items-center gap-2.5' }, h('span', { class: `h-2.5 w-2.5 shrink-0 rounded-sm ${c.cls}` }), c.label)),
      h('td', { class: 'py-2 text-right tabular-nums text-slate-500 dark:text-slate-400' }, c.count.toLocaleString('ru-RU')),
      h('td', { class: 'py-2 text-right tabular-nums text-slate-500 dark:text-slate-400' }, formatSize(c.size)),
      h('td', { class: 'w-14 py-2 text-right font-medium tabular-nums' }, fmtPct(c.size))))));
  return h('div', {}, bar, legend);
}

// Заполненность хранилищ: полоса (если задана квота) + подписи с числами.
function storagesUsage(list, ctx) {
  // Занятое место — по всему бакету (включая объекты других программ), как у провайдера.
  const used = (s) => s.bucketSize ?? s.size;
  const pct = (s) => (s.quota ? Math.min(100, (used(s) / s.quota) * 100) : null);
  return h('ul', { class: 'grid gap-4 sm:grid-cols-2' }, list.map((s) => {
    const p = pct(s);
    const tone = p === null ? '' : p >= 90 ? 'bg-rose-500' : p >= 75 ? 'bg-amber-500' : 'bg-brand-500';
    const status = s.error
      ? h('span', { class: 'badge bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', title: s.error }, 'недоступно')
      : !s.acceptUploads
        ? h('span', { class: 'badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }, 'только чтение')
        : h('span', { class: 'badge bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300' }, 'принимает файлы');
    let bar = null;
    if (p !== null) {
      const fill = h('div', { class: `h-full rounded-full ${tone}` });
      fill.style.width = `${Math.max(p, 1)}%`;
      bar = h('div', { class: 'mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800', role: 'meter',
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p)), 'aria-label': `${s.name}: занято ${Math.round(p)}%` }, fill);
    }
    return h('li', { class: 'rounded-xl border border-slate-200 p-4 dark:border-slate-800' },
      h('div', { class: 'flex items-center justify-between gap-3' },
        h('span', { class: 'flex min-w-0 items-center gap-2 font-medium' }, icon('server', 'h-4 w-4 text-slate-400'), h('span', { class: 'truncate' }, s.name)),
        status),
      bar,
      h('p', { class: 'mt-2 text-sm text-slate-500 dark:text-slate-400' },
        h('span', { class: 'font-medium tabular-nums text-slate-800 dark:text-slate-200' }, formatSize(used(s))),
        s.quota ? ` из ${formatSize(s.quota)} · ${Math.round(p)}%` : ' · без квоты',
        s.storageClass ? ` · ${s.storageClass}` : '',
        h('span', { class: 'block text-xs' },
          `файлообменник: ${formatSize(s.size)}, ${pluralize(s.files, FILES)}${s.complete ? '' : '+'}`,
          (s.bucketSize ?? s.size) > s.size ? ' · остальное — объекты других программ в бакете' : '')));
  }));
}

export function mountHome(view, ctx) {
  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Главная'), ctx.can('editor')
    ? [h('button', { type: 'button', class: 'btn-primary', onclick: () => ctx.pickFiles('') }, icon('upload'), h('span', { class: 'hidden sm:inline' }, 'Загрузить'))]
    : []);

  // «Недавно открытые» — из этого браузера (см. library.js).
  function openedCard() {
    const items = recentFiles().slice(0, 6);
    if (!items.length) return null;
    return h('section', { class: 'card overflow-hidden' },
      h('div', { class: 'border-b border-slate-200 px-5 py-4 dark:border-slate-800' },
        h('h3', { class: 'font-semibold' }, 'Недавно открытые'),
        h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, 'Файлы, которые вы смотрели')),
      h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' }, items.map((f) => h('li', {},
        h('a', { href: diskHash(f.folder), class: 'flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40',
          onclick: () => { ctx.selectAfterNavigate = f.key; } },
        thumbnail(f, { cls: 'h-8 w-8 rounded-lg' }),
        h('span', { class: 'min-w-0 flex-1' },
          h('span', { class: 'block truncate text-sm font-medium' }, f.name),
          h('span', { class: 'block truncate text-xs text-slate-500 dark:text-slate-400', title: formatDate(f.at) }, `${folderLabel(f.folder)} · ${formatDateShort(f.at)}`)))))));
  }

  const tiles = h('div', { class: 'grid grid-cols-2 gap-4 lg:grid-cols-4' },
    [1, 2, 3, 4].map(() => h('div', { class: 'card h-[6.5rem] animate-pulse' })));
  const structure = h('div', { class: 'h-24 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800' });
  const recent = h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' });
  const storagesList = h('div', { class: 'h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800' });

  view.replaceChildren(h('div', { class: 'mx-auto max-w-6xl space-y-6 p-4 sm:p-6' },
    h('div', {},
      h('h2', { class: 'text-2xl font-semibold tracking-tight' }, `${greeting()}, ${ctx.user.username}`),
      h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' }, 'Сводка по вашему диску')),
    tiles,
    h('div', { class: 'grid gap-6 lg:grid-cols-5' },
      h('div', { class: 'space-y-6 lg:col-span-2' },
        h('section', { class: 'card p-5' },
          h('h3', { class: 'font-semibold' }, 'Структура хранилища'),
          h('p', { class: 'mb-4 text-sm text-slate-500 dark:text-slate-400' }, 'Занятое место по типам файлов'),
          structure),
        openedCard()),
      h('section', { class: 'card overflow-hidden lg:col-span-3' },
        h('div', { class: 'flex items-center justify-between border-b border-slate-200 p-5 dark:border-slate-800' },
          h('div', {},
            h('h3', { class: 'font-semibold' }, 'Недавние файлы'),
            h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, 'Последние загрузки на диск')),
          h('a', { href: diskHash(''), class: 'text-sm font-medium text-brand-600 hover:underline dark:text-brand-400' }, 'Открыть диск')),
        recent)),
    h('section', { class: 'card p-5' },
      h('div', { class: 'mb-4 flex items-end justify-between gap-4' },
        h('div', {},
          h('h3', { class: 'font-semibold' }, 'Хранилища'),
          h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' },
            ctx.storages.length > 1 ? `${ctx.storages.length} S3-хранилища объединены в один диск` : 'Где физически лежат файлы')),
        ctx.can('admin') && h('a', { href: '#/settings', class: 'text-sm font-medium text-brand-600 hover:underline dark:text-brand-400' }, 'Управлять')),
      storagesList)));

  let alive = true;
  if (!ctx.storageConfigured) {
    tiles.closest('.space-y-6').replaceChildren(tiles.closest('.space-y-6').firstElementChild, storageNotice(ctx));
    return { unmount() {} };
  }
  (async () => {
    try {
      const [stats, usersCount] = await Promise.all([
        api.stats(),
        ctx.can('admin') ? api.listUsers().then((r) => r.users.length).catch(() => null) : null,
      ]);
      if (!alive) return;
      tiles.replaceChildren(
        statTile('Файлов', stats.files.toLocaleString('ru-RU') + (stats.complete ? '' : '+'), null, 'file'),
        statTile('Занято', formatSize(stats.size), stats.complete ? null : 'по первым 20 000 объектам', 'server'),
        statTile('Папок', stats.folders.toLocaleString('ru-RU'), null, 'folder'),
        usersCount !== null
          ? statTile('Пользователи', usersCount.toLocaleString('ru-RU'), null, 'users')
          : statTile('Ваша роль', ctx.roleLabel(ctx.user.role), null, 'key'));
      structure.replaceWith(breakdown(stats));
      storagesList.replaceWith(storagesUsage(stats.storages, ctx));

      if (!stats.recent.length) {
        recent.replaceChildren(h('li', { class: 'px-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400' }, 'Файлов пока нет'));
      } else {
        recent.replaceChildren(...stats.recent.map((f) => h('li', {},
          h('a', { href: diskHash(f.folder), class: 'flex items-center gap-3 px-5 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/40',
            onclick: () => { ctx.selectAfterNavigate = f.key; } },
          thumbnail(f),
          h('span', { class: 'min-w-0 flex-1' },
            h('span', { class: 'block truncate text-sm font-medium' }, f.name),
            h('span', { class: 'block truncate text-xs text-slate-500 dark:text-slate-400' }, folderLabel(f.folder))),
          h('span', { class: 'shrink-0 text-right text-xs text-slate-500 dark:text-slate-400' },
            h('span', { class: 'block tabular-nums' }, formatSize(f.size)),
            h('span', { class: 'hidden sm:block', title: formatDate(f.lastModified) }, formatDateShort(f.lastModified)))))));
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  })();

  return { unmount() { alive = false; $('#chart-tooltip').classList.add('hidden'); } };
}

