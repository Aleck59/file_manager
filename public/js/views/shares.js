// Раздел «Ссылки»: публичные ссылки пользователя (администратор — все), статистика, отзыв.
import { api } from '../api.js';
import { shareUrl } from '../share-dialog.js';
import { confirmDialog, copyToClipboard, formatDate, formatDateShort, formatSize, h, icon, openDialog, toast } from '../ui.js';

const STATE = {
  active: ['действует', 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'],
  expired: ['истекла', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'],
  exhausted: ['лимит исчерпан', 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'],
  revoked: ['отозвана', 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'],
  missing: ['файл удалён', 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'],
  fulfilled: ['получено', 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'],
};

/** Напоминание по запросу файла: срок близко или прошёл, а файлов нет. */
export function requestReminder(s) {
  if (!s.request || s.uploads || !s.expiresAt || s.state === 'revoked' || s.state === 'fulfilled') return null;
  const left = Date.parse(s.expiresAt) - Date.now();
  if (left <= 0) return 'срок прошёл, файлов нет';
  if (left <= 86_400_000) return 'срок истекает, файлов ещё нет';
  return null;
}
const TYPE = { file: ['file', 'Файл'], folder: ['folder', 'Папка — просмотр'], upload: ['upload', 'Папка — загрузка мне'] };

export function mountShares(view, ctx) {
  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Ссылки'), []);
  let showAll = false;
  const list = h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' });
  const allToggle = ctx.can('admin') && h('label', { class: 'flex items-center gap-2 text-sm' },
    h('input', { type: 'checkbox', class: 'check', onchange: (e) => { showAll = e.target.checked; load(); } }), 'Ссылки всех пользователей');

  view.replaceChildren(h('div', { class: 'mx-auto max-w-5xl space-y-4 p-4 sm:p-6' },
    allToggle && h('div', { class: 'flex justify-end' }, allToggle),
    h('section', { class: 'card overflow-hidden' }, list)));

  function row(s) {
    const [stateText, tone] = STATE[s.state] ?? STATE.active;
    const [ic, typeText] = s.request ? ['upload', 'Запрос файла'] : TYPE[s.type];
    const reminder = requestReminder(s);
    const url = shareUrl(s.id, s.slug);
    const stats = s.type === 'upload'
      ? `загружено ${s.uploads}${s.maxUploads ? ` из ${s.maxUploads}` : ''}`
      : `скачиваний ${s.downloads}${s.maxDownloads ? ` из ${s.maxDownloads}` : ''}`;
    return h('li', { class: 'flex items-start gap-3 px-4 py-3' },
      h('span', { class: 'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }, icon(ic)),
      h('div', { class: 'min-w-0 flex-1' },
        h('div', { class: 'flex flex-wrap items-center gap-2' },
          h('span', { class: 'truncate text-sm font-medium', title: s.name }, s.name),
          h('span', { class: `badge ${tone}` }, stateText),
          s.hasPassword && h('span', { class: 'badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }, 'пароль'),
          reminder && h('span', { class: 'badge bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300' }, reminder)),
        s.request && s.caption && h('p', { class: 'truncate text-xs text-slate-600 dark:text-slate-300' }, `«${s.caption}»`),
        h('p', { class: 'text-xs tabular-nums text-slate-500 dark:text-slate-400' },
          [typeText, stats, s.expiresAt ? `до ${formatDateShort(s.expiresAt)}` : 'бессрочно',
            s.lastAccess && `открывали ${formatDateShort(s.lastAccess)}`, showAll && s.createdBy].filter(Boolean).join(' · ')),
        h('p', { class: 'truncate font-mono text-xs text-slate-400', title: `Создана ${formatDate(s.createdAt)}` }, url)),
      h('div', { class: 'flex shrink-0 gap-0.5' },
        s.type === 'upload' && h('button', { type: 'button', class: 'icon-btn', title: 'Статистика', 'aria-label': `Статистика ссылки «${s.name}»`, onclick: () => showStats(s) }, icon('chart')),
        s.type === 'upload' && !s.request && h('button', { type: 'button', class: 'icon-btn', title: 'Адрес и подпись', 'aria-label': `Адрес и подпись ссылки «${s.name}»`, onclick: () => editPortal(s) }, icon('pencil')),
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
        : [h('li', { class: 'px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400' }, 'Ссылок пока нет. Создать — «Поделиться» в меню файла или папки')]));
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  async function revoke(s) {
    if (!(await confirmDialog('Отозвать ссылку?', `«${s.name}» перестанет открываться по этой ссылке.`, 'Отозвать'))) return;
    try { await api.revokeShare(s.id); toast('Ссылка отозвана', 'success'); load(); } catch (err) { toast(err.message, 'error'); }
  }
  async function editPortal(s) {
    const done = await openDialog({
      title: 'Портал загрузки',
      text: `Адрес вида ${location.host}/<адрес> — латиница, цифры, дефис. Пусто — обычная ссылка /s/…`,
      confirmLabel: 'Сохранить',
      fields: [
        { name: 'slug', label: 'Свой адрес', value: s.slug ?? '', optional: true, maxlength: 40, placeholder: 'a' },
        { name: 'caption', label: 'Подпись на странице', value: s.caption ?? '', optional: true, maxlength: 200, placeholder: 'Загрузить файлы' },
      ],
      onSubmit: ({ slug, caption }) => api.updateShare(s.id, { slug: slug.trim().toLowerCase() || null, caption: caption.trim() || null }),
    });
    if (done?.share) {
      toast('Сохранено', 'success');
      load();
    }
  }
  // Статистика портала: сколько и от кого пришло, когда и с какого IP.
  async function showStats(s) {
    let st;
    try { st = await api.shareStats(s.id); } catch (err) { return toast(err.message, 'error'); }
    const tile = (label, value) => h('div', { class: 'rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/60' },
      h('p', { class: 'text-xs text-slate-500 dark:text-slate-400' }, label), h('p', { class: 'text-lg font-semibold tabular-nums' }, value));
    const table = st.log.length
      ? h('div', { class: 'max-h-80 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800' },
        h('table', { class: 'w-full text-left text-xs' },
          h('thead', { class: 'sticky top-0 bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400' },
            h('tr', {}, ['Когда', 'Кто', 'IP', 'Файл', 'Размер'].map((t) => h('th', { class: 'px-3 py-2 font-medium' }, t)))),
          h('tbody', { class: 'divide-y divide-slate-100 dark:divide-slate-800' }, st.log.map((e) => h('tr', {},
            h('td', { class: 'whitespace-nowrap px-3 py-1.5 tabular-nums' }, formatDateShort(e.at)),
            h('td', { class: 'max-w-[8rem] truncate px-3 py-1.5' }, e.from || '—'),
            h('td', { class: 'whitespace-nowrap px-3 py-1.5 font-mono' }, e.ip || '—'),
            h('td', { class: 'max-w-[12rem] truncate px-3 py-1.5', title: e.name }, e.name),
            h('td', { class: 'whitespace-nowrap px-3 py-1.5 text-right tabular-nums' }, formatSize(e.size)))))))
      : h('p', { class: 'py-8 text-center text-sm text-slate-500' }, 'Пока ничего не загружали');
    const dialog = h('dialog', { class: 'w-[min(44rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' },
      h('div', { class: 'space-y-4 p-6' },
        h('h3', { class: 'truncate text-lg font-semibold' }, s.name),
        h('div', { class: 'grid grid-cols-2 gap-2 sm:grid-cols-4' },
          tile('Файлов', String(st.uploads)), tile('Объём', formatSize(st.bytes)), tile('Отправителей', String(st.senders)),
          tile('Последняя', st.lastUploadAt ? formatDateShort(st.lastUploadAt) : '—')),
        table,
        h('div', { class: 'flex justify-end' }, h('button', { type: 'button', class: 'btn-primary', onclick: () => dialog.close() }, 'Готово'))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  async function remove(s) {
    try { await api.deleteShare(s.id); load(); } catch (err) { toast(err.message, 'error'); }
  }
  load();
  return { unmount() {} };
}
