// Настройки → «Где выполнен вход» (сессии) и «API-токены» — для каждого пользователя.
import { api } from '../api.js';
import { confirmDialog, copyToClipboard, describeUA, formatDate, formatDateShort, h, icon, toast } from '../ui.js';

const muted = 'text-xs text-slate-500 dark:text-slate-400';

export function sessionsBlock() {
  const list = h('ul', { class: 'divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800' },
    h('li', { class: 'h-14 animate-pulse bg-slate-50 dark:bg-slate-800/40' }));
  const others = h('button', { type: 'button', class: 'btn-ghost hidden border border-slate-200 text-rose-600 dark:border-slate-700 dark:text-rose-400', onclick: revokeOthers },
    icon('logout'), 'Выйти на других устройствах');

  async function load() {
    try {
      const { sessions } = await api.sessions();
      list.replaceChildren(...sessions.map((s) => h('li', { class: 'flex items-center gap-3 px-4 py-3' },
        h('span', { class: `flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${s.current ? 'bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}` }, icon('shield')),
        h('div', { class: 'min-w-0 flex-1' },
          h('p', { class: 'flex flex-wrap items-center gap-2 text-sm font-medium' }, describeUA(s.ua),
            s.current && h('span', { class: 'badge bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300' }, 'это устройство')),
          h('p', { class: `${muted} tabular-nums`, title: `Вход: ${formatDate(s.created)}` },
            `${s.ip ?? 'IP неизвестен'} · активность ${formatDateShort(s.lastSeen)}`)),
        !s.current && h('button', { type: 'button', class: 'icon-btn-danger', title: 'Завершить сессию', 'aria-label': `Завершить сессию ${describeUA(s.ua)}`, onclick: () => revoke(s) }, icon('logout')))));
      others.classList.toggle('hidden', sessions.filter((s) => !s.current).length === 0);
    } catch (err) {
      list.replaceChildren(h('li', { class: 'px-4 py-3 text-sm text-rose-600' }, err.message));
    }
  }
  async function revoke(s) {
    if (!(await confirmDialog('Завершить сессию?', `${describeUA(s.ua)}, ${s.ip ?? ''}: на этом устройстве потребуется войти заново.`, 'Завершить'))) return;
    try {
      await api.revokeSession(s.id);
      toast('Сессия завершена', 'success');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  async function revokeOthers() {
    if (!(await confirmDialog('Выйти на других устройствах?', 'Все сессии, кроме этой, будут завершены.', 'Выйти'))) return;
    try {
      const { count } = await api.revokeOtherSessions();
      toast(`Завершено сессий: ${count}`, 'success');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  load();
  return h('div', { class: 'space-y-3' }, list, h('div', {}, others),
    h('p', { class: muted }, 'Если видите незнакомое устройство — завершите сессию и смените пароль.'));
}

export function tokensBlock(ctx) {
  const list = h('ul', { class: 'divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800' });
  const create = h('button', { type: 'button', class: 'btn-ghost border border-slate-200 dark:border-slate-700', onclick: createToken }, icon('plus'), 'Создать токен');

  async function load() {
    try {
      const { tokens } = await api.tokens();
      list.classList.toggle('hidden', !tokens.length);
      list.replaceChildren(...tokens.map((t) => h('li', { class: 'flex items-center gap-3 px-4 py-3' },
        h('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }, icon('token')),
        h('div', { class: 'min-w-0 flex-1' },
          h('p', { class: 'flex flex-wrap items-center gap-2 text-sm font-medium' }, t.name,
            h('span', { class: `badge ${t.readOnly ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'}` }, t.readOnly ? 'только чтение' : 'полный доступ')),
          h('p', { class: `${muted} tabular-nums` }, `fmt_${t.id}_… · создан ${formatDateShort(t.created)} · ${t.lastUsed ? `использован ${formatDateShort(t.lastUsed)}${t.lastIp ? ` с ${t.lastIp}` : ''}` : 'ещё не использовался'}`)),
        h('button', { type: 'button', class: 'icon-btn-danger', title: 'Отозвать токен', 'aria-label': `Отозвать токен «${t.name}»`, onclick: () => revoke(t) }, icon('trash')))));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function revoke(t) {
    if (!(await confirmDialog('Отозвать токен?', `Программы, использующие «${t.name}», перестанут получать доступ.`, 'Отозвать'))) return;
    try {
      await api.revokeToken(t.id);
      toast('Токен отозван', 'success');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function createToken() {
    const name = h('input', { id: 'tok-name', class: 'input', maxlength: 60, placeholder: 'Например: бэкап с сервера', autocomplete: 'off' });
    const ro = h('input', { id: 'tok-ro', type: 'checkbox', class: 'check', checked: !ctx.can('editor') });
    const error = h('p', { class: 'hidden rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', role: 'alert' });
    const body = h('div', { class: 'space-y-4' },
      h('div', {}, h('label', { for: 'tok-name', class: 'mb-1.5 block text-sm font-medium' }, 'Название'), name),
      h('label', { for: 'tok-ro', class: 'flex items-center gap-2 text-sm' }, ro, 'Только чтение (список, скачивание, ссылки)'),
      error);
    const submit = h('button', { type: 'submit', class: 'btn-primary' }, 'Создать');
    const form = h('form', { class: 'space-y-4 p-6' },
      h('h3', { class: 'text-lg font-semibold' }, 'Новый API-токен'),
      h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, `Токен действует с вашими правами (${ctx.roleLabel(ctx.user.role)}) или только на чтение. Его покажут один раз.`),
      body,
      h('div', { class: 'flex justify-end gap-2' },
        h('button', { type: 'button', class: 'btn-ghost', onclick: () => dialog.close() }, 'Отмена'), submit));
    const dialog = h('dialog', { class: 'w-[min(34rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' }, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const { token } = await api.createToken(name.value, ro.checked);
        showToken(token);
        load();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      } finally {
        submit.disabled = false;
      }
    });
    function showToken(token) {
      const origin = location.origin;
      const example = `curl -H "Authorization: Bearer ${token}" "${origin}/api/files?folder="`;
      const copyBtn = (text, label) => h('button', { type: 'button', class: 'icon-btn shrink-0', title: label, 'aria-label': label,
        onclick: async () => { await copyToClipboard(text); toast('Скопировано', 'success'); } }, icon('copy'));
      form.replaceChildren(
        h('h3', { class: 'text-lg font-semibold' }, 'Токен создан'),
        h('p', { class: 'rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-200' },
          'Скопируйте его сейчас — больше он показан не будет. Храните как пароль.'),
        h('div', { class: 'flex items-center gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-950' },
          h('code', { class: 'min-w-0 flex-1 break-all font-mono text-xs' }, token), copyBtn(token, 'Скопировать токен')),
        h('p', { class: 'text-sm font-medium' }, 'Пример: список файлов в корне'),
        h('div', { class: 'flex items-start gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-950' },
          h('code', { class: 'min-w-0 flex-1 break-all font-mono text-xs' }, example), copyBtn(example, 'Скопировать пример')),
        h('p', { class: muted }, 'Загрузка файла скриптом — три запроса: POST /api/uploads → PUT по полученной ссылке → POST /api/uploads/complete (см. README, раздел API).'),
        h('div', { class: 'flex justify-end' }, h('button', { type: 'button', class: 'btn-primary', onclick: () => dialog.close() }, 'Готово')));
    }
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    name.focus();
  }

  load();
  return h('div', { class: 'space-y-3' }, list, h('div', {}, create),
    h('p', { class: muted }, 'Для скриптов и программ: заголовок «Authorization: Bearer <токен>». Управлять токенами можно только отсюда.'));
}
