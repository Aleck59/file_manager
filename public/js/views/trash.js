// Раздел «Корзина»: удалённые файлы и папки, восстановление и удаление навсегда.
import { api } from '../api.js';
import { confirmDialog, FILES, fileBadge, folderLabel, formatDateShort, formatSize, h, icon, pluralize, toast } from '../ui.js';
import { diskHash } from './disk.js';

const DAYS = { one: 'день', few: 'дня', many: 'дней', other: 'дня' };

export function mountTrash(view, ctx) {
  const list = h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' });
  const summary = h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' });
  const emptyBtn = ctx.can('admin') && h('button', { type: 'button', class: 'btn-ghost text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950', onclick: emptyAll }, icon('trash'), 'Очистить корзину');
  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Корзина'), [emptyBtn].filter(Boolean));
  view.replaceChildren(h('div', { class: 'mx-auto max-w-5xl space-y-4 p-4 sm:p-6' },
    summary,
    h('section', { class: 'card overflow-hidden' }, list)));

  let items = [];

  function badge(it) {
    if (it.kind === 'folder') return h('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400' }, icon('folder'));
    if (it.kind === 'files') return h('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }, icon('copy'));
    return fileBadge(it.name);
  }

  function row(it) {
    const left = Math.max(0, Math.ceil((Date.parse(it.expiresAt) - Date.now()) / 86_400_000));
    const title = it.kind === 'files' ? `${pluralize(it.count, FILES)}: ${it.name}${it.count > 3 ? '…' : ''}` : it.name;
    const where = it.kind === 'folder' ? folderLabel(it.folder.slice(0, it.folder.slice(0, -1).lastIndexOf('/') + 1)) : folderLabel(it.folder);
    const details = [
      `из «${where}»`,
      it.kind === 'folder' && pluralize(it.count, { one: 'объект', few: 'объекта', many: 'объектов', other: 'объекта' }),
      formatSize(it.size),
      `удалил ${it.deletedBy} ${formatDateShort(it.deletedAt)}`,
    ].filter(Boolean).join(' · ');
    const busy = (on) => { for (const b of li.querySelectorAll('button')) b.disabled = on; };
    // «N файлов»: каждый можно вернуть или стереть по отдельности.
    const files = it.kind === 'files' && h('ul', { class: 'mt-2 hidden divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800' },
      it.keys.map((key, i) => {
        const name = key.slice(key.indexOf('~') + 1);
        return h('li', { class: 'flex items-center gap-2 px-3 py-1.5' },
          fileBadge(name, 'h-7 w-7 rounded-md', 'h-3.5 w-3.5'),
          h('span', { class: 'min-w-0 flex-1 truncate text-sm', title: name }, name),
          it.sizes && h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500' }, formatSize(it.sizes[i])),
          h('button', { type: 'button', class: 'icon-btn h-8 w-8', title: 'Восстановить', 'aria-label': `Восстановить «${name}»`,
            onclick: async () => { busy(true); await restoreOne(it, key, name); busy(false); } }, icon('undo')),
          h('button', { type: 'button', class: 'icon-btn-danger h-8 w-8', title: 'Удалить навсегда', 'aria-label': `Удалить навсегда «${name}»`,
            onclick: async () => { busy(true); await purgeOne(it, key, name); busy(false); } }, icon('trash')));
      }));
    const toggle = files && h('button', { type: 'button', class: 'mt-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400', 'aria-expanded': 'false',
      onclick: (e) => {
        const open = files.classList.toggle('hidden') === false;
        e.currentTarget.setAttribute('aria-expanded', String(open));
        e.currentTarget.textContent = open ? 'Скрыть файлы' : `Показать файлы (${it.count})`;
      } }, `Показать файлы (${it.count})`);
    const li = h('li', { class: 'flex items-start gap-3 px-4 py-3' },
      badge(it),
      h('div', { class: 'min-w-0 flex-1' },
        h('div', { class: 'flex flex-wrap items-center gap-2' },
          h('span', { class: 'truncate text-sm font-medium', title }, title),
          h('span', { class: `badge ${left <= 3 ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}` },
            left ? `ещё ${pluralize(left, DAYS)}` : 'сегодня удалится')),
        h('p', { class: 'text-xs tabular-nums text-slate-500 dark:text-slate-400' }, details),
        toggle, files),
      h('div', { class: 'flex shrink-0 gap-0.5' },
        h('button', { type: 'button', class: 'btn-ghost px-2.5 py-1.5', title: 'Восстановить', 'aria-label': `Восстановить «${it.name}»`,
          onclick: async () => { busy(true); await restore(it); busy(false); } }, icon('undo'), h('span', { class: 'hidden sm:inline' }, it.kind === 'files' ? 'Восстановить все' : 'Восстановить')),
        h('button', { type: 'button', class: 'icon-btn-danger', title: 'Удалить навсегда', 'aria-label': `Удалить навсегда «${it.name}»`,
          onclick: async () => { busy(true); await purge(it); busy(false); } }, icon('trash'))));
    return li;
  }

  function render(days) {
    const total = items.reduce((a, it) => a + it.size, 0);
    summary.textContent = days
      ? `Хранится ${pluralize(days, DAYS)}${items.length ? ` · ${formatSize(total)}` : ''}`
      : 'Корзина выключена: файлы удаляются сразу (Настройки → Загрузка файлов).';
    list.replaceChildren(...(items.length ? items.map(row)
      : [h('li', { class: 'flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400' },
        icon('trash', 'h-8 w-8 text-slate-300 dark:text-slate-600'), 'Корзина пуста')]));
    if (emptyBtn) emptyBtn.disabled = !items.length;
  }

  async function load() {
    try {
      const r = await api.trash();
      items = r.items;
      render(r.days);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function restore(it) {
    try {
      const r = await api.restoreTrash(it.id);
      toast(r.warnings?.length ? `Восстановлено не всё: ${r.warnings.map((w) => w.storage).join(', ')} недоступно` : `«${it.name}» восстановлено`,
        r.warnings?.length ? 'error' : 'success', { action: { label: 'Открыть', onClick: () => ctx.navigate(diskHash(it.folder)) } });
      ctx.refreshStats?.();
      load();
    } catch (err) {
      toast(err.message, 'error');
      load();
    }
  }

  async function restoreOne(it, key, name) {
    try {
      await api.restoreTrash(it.id, key);
      toast(`«${name}» восстановлен`, 'success', { action: { label: 'Открыть', onClick: () => ctx.navigate(diskHash(it.folder)) } });
      ctx.refreshStats?.();
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  async function purgeOne(it, key, name) {
    if (!(await confirmDialog('Удалить навсегда?', `«${name}» будет стёрт без возможности восстановления.`))) return;
    try {
      await api.purgeTrash(it.id, key);
      load();
      ctx.refreshStats?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function purge(it) {
    if (!(await confirmDialog('Удалить навсегда?', `«${it.name}» будет стёрто без возможности восстановления.`))) return;
    try {
      await api.purgeTrash(it.id);
      items = items.filter((x) => x.id !== it.id);
      load();
      ctx.refreshStats?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function emptyAll() {
    if (!(await confirmDialog('Очистить корзину?', `Всё удалённое (${items.length} ${items.length === 1 ? 'запись' : 'записей'}) будет стёрто навсегда.`, 'Очистить'))) return;
    try {
      await api.emptyTrash();
      toast('Корзина очищена', 'success');
      load();
      ctx.refreshStats?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  load();
  return { unmount() {} };
}
