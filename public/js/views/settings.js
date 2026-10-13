// Раздел «Настройки»: профиль и пароль, интерфейс; для администратора — все параметры сервера.
import { api } from '../api.js';
import { TTL_LABELS } from '../preview.js';
import { adminSettings } from './settings-admin.js';
import { sessionsBlock, tokensBlock, twoFactorBlock } from './security-settings.js';
import { applyTheme, h, prefs, toast } from '../ui.js';

function section(title, description, ...content) {
  return h('section', { class: 'card grid gap-6 p-5 sm:p-6 md:grid-cols-3' },
    h('div', {},
      h('h3', { class: 'font-semibold' }, title),
      h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' }, description)),
    h('div', { class: 'space-y-4 md:col-span-2' }, ...content));
}

function field(label, control, hint) {
  return h('label', { class: 'block' },
    h('span', { class: 'mb-1.5 block text-sm font-medium' }, label),
    control,
    hint && h('span', { class: 'mt-1 block text-xs text-slate-500 dark:text-slate-400' }, hint));
}

function segmented(options, value, onChange, label) {
  const group = h('div', { class: 'segmented', role: 'group', 'aria-label': label });
  const buttons = options.map(([v, text]) => h('button', {
    type: 'button', 'aria-pressed': String(v === value),
    onclick: () => {
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btnFor(v))));
      onChange(v);
    },
  }, text));
  const btnFor = (v) => buttons[options.findIndex(([x]) => x === v)];
  group.append(...buttons);
  return group;
}


export function mountSettings(view, ctx) {
  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Настройки'), []);

  // ---------- профиль ----------
  const pwError = h('p', { class: 'hidden rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', role: 'alert' });
  const pwForm = h('form', { class: 'space-y-4', novalidate: true },
    h('input', { type: 'text', name: 'username', value: ctx.user.username, autocomplete: 'username', class: 'hidden', readonly: true }),
    field('Текущий пароль', h('input', { type: 'password', name: 'current', class: 'input', autocomplete: 'current-password', required: true })),
    h('div', { class: 'grid gap-4 sm:grid-cols-2' },
      field('Новый пароль', h('input', { type: 'password', name: 'next', class: 'input', autocomplete: 'new-password', required: true }), 'Не короче 10 символов'),
      field('Повторите пароль', h('input', { type: 'password', name: 'repeat', class: 'input', autocomplete: 'new-password', required: true }))),
    pwError,
    h('button', { type: 'submit', class: 'btn-primary' }, 'Сменить пароль'));

  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { current, next, repeat } = Object.fromEntries(new FormData(pwForm));
    const fail = (msg) => { pwError.textContent = msg; pwError.classList.remove('hidden'); };
    pwError.classList.add('hidden');
    if (next.length < 10) return fail('Новый пароль должен быть не короче 10 символов');
    if (next !== repeat) return fail('Пароли не совпадают');
    const btn = pwForm.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api.changePassword(current, next);
      pwForm.reset();
      toast('Пароль изменён. Сессии на других устройствах завершены.', 'success');
    } catch (err) {
      fail(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  const profile = section('Профиль', 'Ваша учётная запись и пароль.',
    h('div', { class: 'flex items-center gap-3' },
      h('span', { class: 'flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-lg font-semibold uppercase text-brand-700 dark:bg-brand-900 dark:text-brand-200' }, ctx.user.username.slice(0, 1)),
      h('div', {},
        h('p', { class: 'font-medium' }, ctx.user.username),
        h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, ctx.roleLabel(ctx.user.role)))),
    h('div', { class: 'border-t border-slate-200 pt-4 dark:border-slate-800' }, pwForm));

  // ---------- интерфейс ----------
  const ui = section('Интерфейс', 'Хранятся в этом браузере.',
    field('Тема', segmented([['system', 'Системная'], ['light', 'Светлая'], ['dark', 'Тёмная']], prefs.get('theme', 'system'),
      (v) => { prefs.set('theme', v); applyTheme(v); }, 'Тема')),
    field('Срок действия ссылок по умолчанию',
      segmented(Object.entries(TTL_LABELS), prefs.get('link-ttl', '86400'), (v) => { prefs.set('link-ttl', v); toast(`Ссылки будут действовать ${TTL_LABELS[v]}`); }, 'Срок ссылок'),
      'Для кнопки «Скопировать ссылку». Максимум, который допускает S3, — 7 дней.'),
    ctx.can('editor') && field('Ограничение скорости загрузки',
      segmented([['0', 'Нет'], ['1', '1 МБ/с'], ['5', '5 МБ/с'], ['10', '10 МБ/с'], ['50', '50 МБ/с']], prefs.get('upload-limit', '0'),
        (v) => { prefs.set('upload-limit', v); toast(v === '0' ? 'Загрузка без ограничения скорости' : `Загрузка не быстрее ${v} МБ/с в среднем`); }, 'Скорость загрузки'),
      'Чтобы загрузка не занимала весь канал. Ограничение среднее: браузер отправляет файл частями и делает паузы между ними.'));

  const security = section('Где выполнен вход', 'Устройства и браузеры, в которых открыт ваш аккаунт.', sessionsBlock());
  const tokens = section('API-токены', 'Доступ для скриптов и программ без пароля.', tokensBlock(ctx));
  const twoFactor = section('Двухфакторная аутентификация', 'Код из приложения на телефоне при каждом входе.', twoFactorBlock(ctx));
  const sections = [profile, twoFactor, security, ui, tokens];

  // Все параметры сервера (.env) — только для администратора.
  if (ctx.can('admin')) sections.push(adminSettings(ctx));

  view.replaceChildren(h('div', { class: 'mx-auto max-w-4xl space-y-6 p-4 sm:p-6' },
    ...sections));

  return { unmount() {} };
}
