// Раздел «Ссылки»: публичные ссылки пользователя (администратор — все), статистика, отзыв.
import { api } from '../api.js';
import { shareUrl } from '../share-dialog.js';
import { confirmDialog, copyToClipboard, formatDate, formatDateShort, h, icon, toast } from '../ui.js';

const STATE = {
  active: ['действует', 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'],
  expired: ['истекла', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'],
  exhausted: ['лимит исчерпан', 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'],
  revoked: ['отозвана', 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'],
  missing: ['файл удалён', 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'],
};
const TYPE = { file: ['file', 'Файл'], folder: ['folder', 'Папка — просмотр'], upload: ['upload', 'Папка — загрузка мне'] };

export function mountShares(view, ctx) {
  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Ссылки'), []);
  let showAll = false;
  const list = h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' });
  const allToggle = ctx.can('admin') && h('label', { class: 'flex items-center gap-2 text-sm' },
    h('input', { type: 'checkbox', class: 'check', onchange: (e) => { showAll = e.target.checked; load(); } }), 'Ссылки всех пользователей');

  view.replaceChildren(h('div', { class: 'mx-auto max-w-5xl space-y-4 p-4 sm:p-6' },
    h('div', { class: 'flex flex-wrap items-center justify-between gap-3' },
      h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, 'Публичные ссылки на файлы и папки: открываются без входа. Создать — «Поделиться» в меню файла или папки.'),
      allToggle),
    h('section', { class: 'card overflow-hidden' }, list)));

  function row(s) {
    const [stateText, tone] = STATE[s.state] ?? STATE.active;
    const [ic, typeText] = TYPE[s.type];
    const url = shareUrl(s.id);
    const stats = s.type === 'upload'
      ? `загружено ${s.uploads}${s.maxUploads ? ` из ${s.maxUploads}` : ''}`
      : `скачиваний ${s.downloads}${s.maxDownloads ? ` из ${s.maxDownloads}` : ''}`;
    return h('li', { class: 'flex items-start gap-3 px-4 py-3' },
      h('span', { class: 'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }, icon(ic)),
      h('div', { class: 'min-w-0 flex-1' },
        h('div', { class: 'flex flex-wrap items-center gap-2' },
          h('span', { class: 'truncate text-sm font-medium', title: s.name }, s.name),
          h('span', { class: `badge ${tone}` }, stateText),
          s.hasPassword && h('span', { class: 'badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }, 'пароль')),
        h('p', { class: 'text-xs tabular-nums text-slate-500 dark:text-slate-400' },
          [typeText, stats, s.expiresAt ? `до ${formatDateShort(s.expiresAt)}` : 'бессрочно',
            s.lastAccess && `открывали ${formatDateShort(s.lastAccess)}`, showAll && s.createdBy].filter(Boolean).join(' · ')),
        h('p', { class: 'truncate font-mono text-xs text-slate-400', title: `Создана ${formatDate(s.createdAt)}` }, url)),
      h('div', { class: 'flex shrink-0 gap-0.5' },
        s.state === 'active' && h('button', { type: 'button', class: 'icon-btn', title: 'Скопировать', 'aria-label': `Скопировать ссылку на «${s.name}»`,
          onclick: async () => { await copyToClipboard(url); toast('Ссылка скопирована', 'success'); } }, icon('copy')),
        s.state === 'active'
          ? h('button', { type: 'button', class: 'icon-btn-danger', title: 'Отозвать', 'aria-label': `Отозвать ссылку на «${s.name}»`, onclick: () => revoke(s) }, icon('close'))
          : h('button', { type: 'button', class: 'icon-btn-danger', title: 'Убрать из списка', 'aria-label': `Убрать ссылку на «${s.name}»`, onclick: () => remove(s) }, icon('trash'))));
  }

  async function load() {
    try {
      const { shares } = await api.shares(showAll);
      list.replaceChildren(...(shares.length ? shares.map(row)
        : [h('li', { class: 'px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400' }, 'Ссылок пока нет')]));
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  async function revoke(s) {
    if (!(await confirmDialog('Отозвать ссылку?', `«${s.name}» перестанет открываться по этой ссылке.`, 'Отозвать'))) return;
    try { await api.revokeShare(s.id); toast('Ссылка отозвана', 'success'); load(); } catch (err) { toast(err.message, 'error'); }
  }
  async function remove(s) {
    try { await api.deleteShare(s.id); load(); } catch (err) { toast(err.message, 'error'); }
  }
  load();
  return { unmount() {} };
}
