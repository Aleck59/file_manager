// Раздел «Журнал» (только администратор): кто, что и когда сделал.
import { api } from '../api.js';
import { describeUA, folderLabel, formatDate, formatSize, h, icon, toast } from '../ui.js';

const ACTIONS = {
  'auth.login': ['Вход в систему', 'logout'],
  'auth.fail': ['Неудачный вход', 'alert'],
  'auth.logout': ['Выход', 'logout'],
  'file.upload': ['Загрузка файла', 'upload'],
  'file.upload_url': ['Загрузка по ссылке', 'globe'],
  'file.delete': ['Удаление файла', 'trash'],
  'file.move': ['Перемещение / переименование', 'move'],
  'file.copy': ['Копирование файла', 'copy'],
  'file.transfer': ['Перенос в другое хранилище', 'server'],
  'folder.create': ['Новая папка', 'folderPlus'],
  'folder.delete': ['Удаление папки', 'trash'],
  'user.create': ['Новый пользователь', 'users'],
  'user.update': ['Изменение пользователя', 'users'],
  'user.delete': ['Удаление пользователя', 'users'],
  'settings.update': ['Изменение настроек', 'settings'],
  'settings.reset': ['Сброс настроек к .env', 'settings'],
  'settings.import': ['Импорт настроек', 'settings'],
  'settings.export': ['Экспорт настроек', 'download'],
  'storage.add': ['Подключение хранилища', 'server'],
  'storage.update': ['Изменение хранилища', 'server'],
  'storage.remove': ['Отключение хранилища', 'server'],
  'storage.placement': ['Политика размещения', 'server'],
  'sessions.reset_all': ['Завершение всех сессий', 'shield'],
  'session.revoke': ['Завершение сессии', 'shield'],
  'token.create': ['Новый API-токен', 'token'],
  'token.revoke': ['Отзыв API-токена', 'token'],
  'server.restart': ['Перезапуск сервера', 'refresh'],
};
const GROUPS = [['', 'Все действия'], ['auth', 'Входы'], ['file', 'Файлы'], ['folder', 'Папки'], ['user', 'Пользователи'],
  ['settings', 'Настройки'], ['storage', 'Хранилища'], ['session', 'Сессии'], ['token', 'API-токены']];

// Имя файла из ключа «…~имя» — понятнее, чем ключ целиком.
const nameFromKey = (key) => String(key ?? '').split('~').slice(1).join('~') || String(key ?? '');
const folderOf = (key) => { const k = String(key ?? '').replace(/^[^:]+:/, ''); return k.slice(0, k.lastIndexOf('/') + 1); };

function describe(e) {
  const d = e.details ?? {};
  switch (e.action) {
    case 'file.upload': case 'file.delete': return `${nameFromKey(d.key)}${d.size ? ` · ${formatSize(d.size)}` : ''} · ${folderLabel(folderOf(d.key))}`;
    case 'file.upload_url': return `${nameFromKey(d.key)} · ${formatSize(d.size ?? 0)} · с ${d.host}`;
    case 'file.transfer': return `${nameFromKey(d.key)} · ${formatSize(d.size ?? 0)} → ${d.to}`;
    case 'file.move': case 'file.copy': return `${nameFromKey(d.from)} → ${folderLabel(folderOf(d.to))} / ${nameFromKey(d.to)}`;
    case 'folder.create': case 'folder.delete': return folderLabel(d.path ?? '');
    case 'settings.update': case 'settings.reset': return (d.keys ?? []).join(', ');
    case 'storage.add': case 'storage.update': case 'storage.remove': return `${d.name ?? ''}${d.bucket ? ` (${d.bucket})` : ''}`;
    case 'auth.login': return d.ua ? describeUA(d.ua) : '';
    default: return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
  }
}

export function mountAudit(view, ctx) {
  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Журнал действий'), []);
  const state = { user: '', action: '', q: '', entries: [], done: false };

  const userSel = h('select', { class: 'select', 'aria-label': 'Пользователь', onchange: (e) => { state.user = e.target.value; reload(); } }, h('option', { value: '' }, 'Все пользователи'));
  const actionSel = h('select', { class: 'select', 'aria-label': 'Тип действия', onchange: (e) => { state.action = e.target.value; reload(); } },
    GROUPS.map(([v, l]) => h('option', { value: v }, l)));
  let timer;
  const search = h('input', { type: 'search', class: 'input py-1.5', placeholder: 'Поиск: имя файла, IP…', 'aria-label': 'Поиск по журналу',
    oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value.trim(); reload(); }, 250); } });
  const list = h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' });
  const more = h('button', { type: 'button', class: 'btn-ghost', onclick: () => load(true) }, 'Показать раньше');
  const moreWrap = h('div', { class: 'hidden border-t border-slate-200 p-3 text-center dark:border-slate-800' }, more);

  view.replaceChildren(h('div', { class: 'mx-auto max-w-5xl space-y-4 p-4 sm:p-6' },
    h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' },
      'Входы, загрузки, удаления, перемещения и изменения настроек. Хранится в data/audit.log (последние ~2 МБ и одна прошлая часть).'),
    h('section', { class: 'card overflow-hidden' },
      h('div', { class: 'flex flex-wrap items-center gap-2 border-b border-slate-200 p-4 dark:border-slate-800' },
        userSel, actionSel, h('div', { class: 'min-w-[12rem] flex-1' }, search)),
      list, moreWrap)));

  function row(e) {
    const [label, ic] = ACTIONS[e.action] ?? [e.action, 'clock'];
    const danger = e.action === 'auth.fail' || e.action.endsWith('.delete') || e.action === 'storage.remove';
    return h('li', { class: 'flex items-start gap-3 px-4 py-3' },
      h('span', { class: `mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${danger ? 'bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}` }, icon(ic)),
      h('div', { class: 'min-w-0 flex-1' },
        h('div', { class: 'flex flex-wrap items-baseline gap-x-2' },
          h('span', { class: 'text-sm font-medium' }, label),
          h('span', { class: 'text-sm text-slate-500 dark:text-slate-400' }, e.user)),
        h('p', { class: 'break-words text-xs text-slate-500 dark:text-slate-400' }, describe(e))),
      h('div', { class: 'shrink-0 text-right text-xs tabular-nums text-slate-500 dark:text-slate-400' },
        h('div', {}, formatDate(e.at)),
        e.ip && h('div', {}, e.ip)));
  }

  let seq = 0;
  async function load(append = false) {
    const my = ++seq;
    more.disabled = true;
    try {
      const before = append ? state.entries.at(-1)?.at : undefined;
      const res = await api.audit({ limit: 100, before, user: state.user || undefined, action: state.action || undefined, q: state.q || undefined });
      if (my !== seq) return;
      state.entries = append ? state.entries.concat(res.entries) : res.entries;
      state.done = res.entries.length < 100;
      const cur = userSel.value;
      userSel.replaceChildren(h('option', { value: '' }, 'Все пользователи'), ...res.users.map((u) => h('option', { value: u, selected: u === cur }, u)));
      list.replaceChildren(...(state.entries.length ? state.entries.map(row)
        : [h('li', { class: 'px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400' }, 'Записей нет')]));
      moreWrap.classList.toggle('hidden', state.done);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      more.disabled = false;
    }
  }
  const reload = () => load(false);
  reload();
  return { unmount() { clearTimeout(timer); } };
}
