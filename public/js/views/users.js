// Раздел «Пользователи» (только для администратора).
import { api } from '../api.js';
import { confirmDialog, formatDate, formatSize, h, icon, openDialog, toast } from '../ui.js';
import { diskHash } from './disk.js';

const ROLE_HINT = {
  viewer: 'просмотр и скачивание',
  editor: 'загрузка, папки, удаление',
  admin: 'полный доступ, управление пользователями',
};

export function mountUsers(view, ctx) {
  let users = [];
  let roles = ['viewer', 'editor', 'admin'];
  let personalForAll = false;
  const roleOptions = () => roles.map((r) => [r, `${ctx.roleLabel(r)} — ${ROLE_HINT[r]}`]);

  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Пользователи'), [
    h('button', { type: 'button', class: 'btn-primary', onclick: addUser }, icon('plus'), h('span', { class: 'hidden sm:inline' }, 'Добавить')),
  ]);

  const list = h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' },
    [1, 2, 3].map(() => h('li', { class: 'p-4' }, h('div', { class: 'h-10 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800' }))));

  view.replaceChildren(h('div', { class: 'mx-auto max-w-4xl space-y-6 p-4 sm:p-6' },
    h('section', { class: 'card overflow-hidden' }, list)));

  function row(u) {
    const self = u.username === ctx.user.username;
    const roleSelect = h('select', {
      class: 'select', 'aria-label': `Роль пользователя ${u.username}`, disabled: self,
      title: self ? 'Нельзя изменить собственную роль' : 'Роль',
      onchange: async (e) => {
        const prev = u.role;
        try {
          await api.updateUser(u.username, { role: e.target.value });
          u.role = e.target.value;
          toast(`Роль ${u.username}: ${ctx.roleLabel(u.role)}`, 'success');
        } catch (err) {
          e.target.value = prev;
          toast(err.message, 'error');
        }
      },
    }, roles.map((r) => h('option', { value: r, selected: r === u.role }, ctx.roleLabel(r))));

    return h('li', { class: 'flex flex-wrap items-center gap-3 p-4' },
      h('span', { class: 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300' }, u.username.slice(0, 1)),
      h('div', { class: 'min-w-0 flex-1' },
        h('p', { class: 'flex items-center gap-2 truncate font-medium' }, u.username,
          self && h('span', { class: 'badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }, 'это вы')),
        h('p', { class: 'flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400' },
          h('span', {}, `Создан ${formatDate(u.createdAt)}`),
          u.email && h('span', { title: 'Вход через Яндекс/Google с этой почтой' }, `· ${u.email}`),
          u.quotaMb > 0 && h('span', {}, `· квота ${formatSize(u.quotaMb * 1024 * 1024)}`),
          u.personalPath && h('a', { href: diskHash(u.personalPath), class: 'badge bg-sky-50 text-sky-700 hover:underline dark:bg-sky-950/60 dark:text-sky-300', title: u.personalPath }, 'личная папка'),
          u.twoFactor && h('span', { class: 'badge bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300', title: 'Двухфакторная аутентификация включена' }, '2FA'))),
      roleSelect,
      h('div', { class: 'flex gap-0.5' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Почта и квота', 'aria-label': `Почта и квота ${u.username}`, onclick: () => editProfile(u) }, icon('pencil')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Сменить пароль', 'aria-label': `Сменить пароль ${u.username}`, onclick: () => resetPassword(u) }, icon('key')),
        u.twoFactor && h('button', { type: 'button', class: 'icon-btn', title: 'Сбросить 2FA', 'aria-label': `Сбросить двухфакторную аутентификацию ${u.username}`, onclick: () => resetTwoFactor(u) }, icon('shield')),
        h('button', { type: 'button', class: 'icon-btn-danger', title: self ? 'Нельзя удалить себя' : 'Удалить', 'aria-label': `Удалить ${u.username}`, disabled: self, onclick: () => removeUser(u) }, icon('trash'))));
  }

  const render = () => list.replaceChildren(...users.map(row));

  async function load() {
    try {
      ({ users, roles, personalForAll } = await api.listUsers());
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function addUser() {
    const created = await openDialog({
      title: 'Новый пользователь',
      confirmLabel: 'Создать',
      fields: [
        { name: 'username', label: 'Логин', hint: '3–32 символа: латиница, цифры, точка, дефис, подчёркивание', maxlength: 32, autocomplete: 'off' },
        { name: 'password', label: 'Пароль', type: 'password', hint: 'Не короче 10 символов', autocomplete: 'new-password' },
        { name: 'role', label: 'Роль', type: 'select', value: 'editor', options: roleOptions() },
        !personalForAll && { name: 'personal', label: 'Личная папка', type: 'checkbox', value: false, hint: 'Своя папка, которую видит только этот пользователь' },
        { name: 'quotaMb', label: 'Квота личной папки, МБ', type: 'number', value: '0', inputmode: 'numeric', optional: true, hint: '0 — без ограничения' },
      ].filter(Boolean),
      onSubmit: (values) => api.createUser({ ...values, quotaMb: Number(values.quotaMb) || 0, personal: personalForAll || values.personal }),
    });
    if (created) {
      toast(`Пользователь ${created.user.username} создан`, 'success');
      load();
    }
  }

  async function resetPassword(u) {
    const self = u.username === ctx.user.username;
    const done = await openDialog({
      title: `Новый пароль для ${u.username}`,
      text: self ? 'После смены пароля потребуется войти заново.' : 'Все активные сессии пользователя будут завершены.',
      confirmLabel: 'Сохранить',
      fields: [{ name: 'password', label: 'Новый пароль', type: 'password', hint: 'Не короче 10 символов', autocomplete: 'new-password' }],
      onSubmit: ({ password }) => api.updateUser(u.username, { password }),
    });
    if (done) {
      toast('Пароль изменён', 'success');
      if (self) window.location.replace('/login');
    }
  }

  async function editProfile(u) {
    const done = await openDialog({
      title: `Профиль ${u.username}`,
      text: 'Почта нужна для входа через Яндекс или Google: войти сможет владелец аккаунта с этой подтверждённой почтой. Квота ограничивает личную папку (0 — без ограничения).',
      confirmLabel: 'Сохранить',
      fields: [
        { name: 'email', label: 'Почта', type: 'email', value: u.email ?? '', optional: true, autocomplete: 'off', placeholder: 'не указана' },
        !personalForAll && { name: 'personal', label: 'Личная папка', type: 'checkbox', value: u.personal, hint: 'Выключение не удаляет папку и файлы' },
        { name: 'quotaMb', label: 'Квота личной папки, МБ', type: 'number', value: String(u.quotaMb ?? 0), inputmode: 'numeric' },
      ].filter(Boolean),
      onSubmit: ({ email, quotaMb, personal }) => api.updateUser(u.username, {
        email: email.trim() || null, quotaMb: Number(quotaMb) || 0, ...(personal !== undefined && { personal }),
      }),
    });
    if (done?.user) {
      toast('Сохранено', 'success');
      load();
    }
  }

  async function resetTwoFactor(u) {
    if (!(await confirmDialog('Сбросить 2FA?', `Для входа «${u.username}» снова будет достаточно пароля. Пользователь сможет включить 2FA заново в настройках.`, 'Сбросить'))) return;
    try {
      await api.resetTwoFactor(u.username);
      u.twoFactor = false;
      render();
      toast('Двухфакторная аутентификация сброшена', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeUser(u) {
    if (!(await confirmDialog('Удалить пользователя?', `Учётная запись «${u.username}» будет удалена, все её сессии завершатся. Файлы на диске останутся.`))) return;
    try {
      await api.deleteUser(u.username);
      users = users.filter((x) => x.username !== u.username);
      render();
      toast('Пользователь удалён', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  load();
  return { unmount() {} };
}
