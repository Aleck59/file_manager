// Раздел «Дубликаты»: одинаковые файлы (размер и хеш), сколько места можно освободить.
import { api } from '../api.js';
import { confirmDialog, fileBadge, folderLabel, formatDateShort, formatSize, h, icon, pluralize, toast } from '../ui.js';
import { diskHash } from './disk.js';

const COPIES = { one: 'копия', few: 'копии', many: 'копий', other: 'копии' };

export function mountDuplicates(view, ctx) {
  const canEdit = ctx.can('editor');
  const summary = h('div', { class: 'card flex flex-wrap items-center gap-4 p-4' });
  const list = h('div', { class: 'space-y-3' });
  const refresh = h('button', { type: 'button', class: 'btn-ghost', onclick: () => load(true) }, icon('refresh'), 'Проверить снова');
  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Дубликаты'), [refresh]);
  view.replaceChildren(h('div', { class: 'mx-auto max-w-5xl space-y-4 p-4 sm:p-6' }, summary, list));

  let data = null;
  let unmounted = false;

  function render() {
    const reclaimable = data.groups.reduce((s, g) => s + (g.files.length - 1) * g.size, 0);
    summary.replaceChildren(
      h('span', { class: 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400' }, icon('copy', 'h-5 w-5')),
      h('div', { class: 'min-w-0 flex-1' },
        h('p', { class: 'text-lg font-semibold' }, data.groups.length ? `Можно освободить ${formatSize(reclaimable)}` : 'Дубликатов нет'),
        h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' },
          `${data.groups.length ? `${pluralize(data.groups.length, { one: 'группа', few: 'группы', many: 'групп', other: 'группы' })} одинаковых файлов · ` : ''}проверено ${formatDateShort(data.scannedAt)}`)));
    list.replaceChildren(...data.groups.map(groupCard));
  }

  function groupCard(g) {
    const rows = g.files.map((f) => {
      const del = canEdit && h('button', {
        type: 'button', class: 'icon-btn text-rose-600 dark:text-rose-400', title: 'Удалить эту копию', 'aria-label': `Удалить ${f.name} из «${folderLabel(f.folder)}»`,
        disabled: g.files.length < 2, onclick: () => remove(g, f),
      }, icon('trash'));
      return h('li', { class: 'flex items-center gap-3 px-4 py-2.5' },
        fileBadge(f.name),
        h('div', { class: 'min-w-0 flex-1' },
          h('p', { class: 'truncate text-sm font-medium' }, f.name),
          h('a', { href: diskHash(f.folder, f.key), class: 'block truncate text-xs text-slate-500 hover:underline dark:text-slate-400' }, `${folderLabel(f.folder)} · ${formatDateShort(f.lastModified)}`)),
        del);
    });
    return h('section', { class: 'card overflow-hidden' },
      h('div', { class: 'flex items-center gap-2 border-b border-slate-200 bg-slate-50/60 px-4 py-2 text-sm dark:border-slate-800 dark:bg-slate-900/60' },
        h('span', { class: 'font-medium tabular-nums' }, formatSize(g.size)),
        h('span', { class: 'text-slate-500 dark:text-slate-400' }, `· ${g.files.length} ${pluralize(g.files.length, COPIES).replace(/^\d+\s/, '')} · лишние занимают ${formatSize((g.files.length - 1) * g.size)}`)),
      h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' }, rows));
  }

  async function remove(g, f) {
    if (!(await confirmDialog('Удалить копию?', `«${f.name}» из «${folderLabel(f.folder)}». Остальные копии останутся.`))) return;
    try {
      await api.deleteFile(f.key);
      g.files = g.files.filter((x) => x.key !== f.key);
      if (g.files.length < 2) data.groups = data.groups.filter((x) => x !== g);
      render();
      ctx.refreshStats?.();
      toast('Копия удалена', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function load(refreshNow = false) {
    refresh.disabled = true;
    summary.replaceChildren(h('div', { class: 'h-12 w-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800' }));
    try {
      data = await api.duplicates(refreshNow);
      if (unmounted) return;
      render();
      if (data.warnings?.length) toast('Часть хранилищ недоступна — список может быть неполным', 'error');
    } catch (err) {
      summary.replaceChildren(h('p', { class: 'text-sm text-rose-600' }, err.message));
    } finally {
      refresh.disabled = false;
    }
  }
  load();
  return { unmount() { unmounted = true; } };
}
