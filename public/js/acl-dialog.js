// «Доступ…» к папке (администратор): кто видит и кто может менять папку и всё внутри.
import { api } from './api.js';
import { folderLabel, h, icon, toast } from './ui.js';

const OTHERS = [['role', 'По роли — как во всём диске'], ['read', 'Только просмотр'], ['none', 'Нет доступа (папка скрыта)']];
const LEVEL = [['', 'как остальные'], ['write', 'просмотр и изменения'], ['read', 'только просмотр'], ['none', 'нет доступа']];
const ROLE = { viewer: 'Просмотр', editor: 'Редактор', admin: 'Администратор' };

/** @returns {Promise<boolean>} изменилось ли правило */
export async function openAclDialog(folder) {
  let data;
  try {
    data = await api.acl(folder);
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
  const rule = data.own ?? { users: {}, others: 'role' };
  return new Promise((resolve) => {
    let changed = false;
    const select = (options, value, label) => h('select', { class: 'select', 'aria-label': label },
      options.map(([v, l]) => h('option', { value: v, selected: v === (value ?? '') }, l)));
    const others = select(OTHERS, rule.others, 'Остальные пользователи');
    const users = data.users.filter((u) => u.role !== 'admin');
    const rows = users.map((u) => ({ u, sel: select(LEVEL, rule.users?.[u.username] ?? '', `Доступ для ${u.username}`) }));
    const error = h('p', { class: 'hidden rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', role: 'alert' });
    const save = h('button', { type: 'submit', class: 'btn-primary' }, 'Сохранить');
    const clear = data.own && !data.own.personal && h('button', { type: 'button', class: 'btn-ghost mr-auto text-rose-600 dark:text-rose-400', onclick: () => submit(null) }, 'Снять ограничения');
    const form = h('form', { class: 'space-y-4 p-6' },
      h('div', {},
        h('h3', { class: 'text-lg font-semibold' }, 'Доступ к папке'),
        h('p', { class: 'mt-1 break-words text-sm text-slate-500 dark:text-slate-400' }, folderLabel(folder))),
      data.own?.personal && h('p', { class: 'rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-950/50 dark:text-sky-200' }, `Личная папка пользователя «${data.own.personal}».`),
      !data.own && data.inherited && h('p', { class: 'rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-950' }, `Сейчас действуют права папки «${folderLabel(data.inherited.path)}». Сохранение задаст для этой папки свои.`),
      h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, 'Права действуют на папку и всё внутри. Роль — потолок: пользователю с ролью «Просмотр» изменения не дать. Администраторы видят всё.'),
      h('label', { class: 'block' }, h('span', { class: 'mb-1.5 block text-sm font-medium' }, 'Остальные пользователи'), others),
      rows.length ? h('div', {},
        h('p', { class: 'mb-1.5 text-sm font-medium' }, 'Отдельным пользователям'),
        h('ul', { class: 'max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800' },
          rows.map(({ u, sel }) => h('li', { class: 'flex items-center gap-3 px-3 py-2' },
            h('span', { class: 'min-w-0 flex-1' }, h('span', { class: 'block truncate text-sm font-medium' }, u.username), h('span', { class: 'text-xs text-slate-500' }, ROLE[u.role] ?? u.role)),
            sel)))) : h('p', { class: 'text-sm text-slate-500' }, 'Других пользователей, кроме администраторов, нет.'),
      error,
      h('div', { class: 'flex flex-wrap justify-end gap-2' }, clear, h('button', { type: 'button', class: 'btn-ghost', onclick: () => dialog.close() }, 'Отмена'), save));
    const dialog = h('dialog', { class: 'w-[min(34rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' }, form);

    async function submit(next) {
      save.disabled = true;
      error.classList.add('hidden');
      try {
        await api.setAcl(folder, next);
        changed = true;
        toast(next ? 'Права сохранены' : 'Ограничения сняты', 'success');
        dialog.close();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      } finally {
        save.disabled = false;
      }
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const map = {};
      for (const { u, sel } of rows) if (sel.value) map[u.username] = sel.value;
      submit({ users: map, others: others.value });
    });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(changed); });
    document.body.append(dialog);
    dialog.showModal();
    others.focus();
  });
}
