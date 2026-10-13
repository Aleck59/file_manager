// Настройки → «Двухфакторная аутентификация», «Где выполнен вход» (сессии) и «API-токены».
import { api } from '../api.js';
import { confirmDialog, copyToClipboard, describeUA, formatDate, formatDateShort, h, icon, openDialog, toast } from '../ui.js';
import qrcode from '../vendor/qrcode.js';

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

// ---------- двухфакторная аутентификация ----------
function qrCanvas(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const scale = 5;
  const m = 3;
  const canvas = h('canvas', { width: (n + m * 2) * scale, height: (n + m * 2) * scale, class: 'h-44 w-44 rounded-lg [image-rendering:pixelated]', role: 'img', 'aria-label': 'QR-код для приложения-аутентификатора' });
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#0f172a';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + m) * scale, (r + m) * scale, scale, scale);
  return canvas;
}

function recoveryList(codes) {
  const text = codes.join('\n');
  return h('div', { class: 'space-y-2' },
    h('p', { class: 'text-sm' }, 'Коды восстановления — на случай, если телефона не будет под рукой. Каждый срабатывает один раз. Сохраните их в надёжном месте: больше они не покажутся.'),
    h('ul', { class: 'grid grid-cols-2 gap-1 rounded-xl bg-slate-50 p-3 font-mono text-sm dark:bg-slate-950' }, codes.map((c) => h('li', {}, c))),
    h('div', { class: 'flex gap-2' },
      h('button', { type: 'button', class: 'btn-ghost border border-slate-200 dark:border-slate-700', onclick: async () => { await copyToClipboard(text); toast('Коды скопированы', 'success'); } }, icon('copy'), 'Скопировать'),
      h('a', { class: 'btn-ghost border border-slate-200 dark:border-slate-700', download: 'коды-восстановления.txt', href: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}` }, icon('download'), 'Скачать')));
}

export function twoFactorBlock(ctx) {
  const box = h('div', { class: 'space-y-3' });
  const passwordDialog = (title, text, confirmLabel, danger) => openDialog({
    title, text, confirmLabel, danger,
    fields: [{ name: 'password', label: 'Пароль', type: 'password', autocomplete: 'current-password', value: '' }],
    onSubmit: ({ password }) => (password ? { password } : Promise.reject(new Error('Введите пароль'))),
  });

  function render() {
    const on = ctx.user.twoFactor;
    const status = h('div', { class: 'flex items-center gap-3' },
      h('span', { class: `flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${on ? 'bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}` }, icon('shield')),
      h('div', { class: 'min-w-0 flex-1' },
        h('p', { class: 'text-sm font-medium' }, on ? 'Включена' : 'Выключена'),
        h('p', { class: muted }, on ? 'При входе кроме пароля нужен код из приложения.' : 'Защитите аккаунт: даже узнав пароль, без телефона войти не получится.')));
    const actions = on
      ? h('div', { class: 'flex flex-wrap gap-2' },
        h('button', { type: 'button', class: 'btn-ghost border border-slate-200 dark:border-slate-700', onclick: newCodes }, icon('key'), 'Новые коды восстановления'),
        h('button', { type: 'button', class: 'btn-ghost border border-slate-200 text-rose-600 dark:border-slate-700 dark:text-rose-400', onclick: disable }, 'Выключить'))
      : h('div', {}, h('button', { type: 'button', class: 'btn-primary', onclick: setup }, icon('shield'), 'Включить'));
    box.replaceChildren(status, actions);
  }

  async function setup() {
    let data;
    try {
      data = await api.twoFactorSetup();
    } catch (err) {
      return toast(err.message, 'error');
    }
    const code = h('input', { id: 'totp-code', class: 'input w-40 text-center font-mono tracking-[0.3em]', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '000000' });
    const error = h('p', { class: 'hidden text-sm text-rose-600', role: 'alert' });
    const confirm = h('button', { type: 'submit', class: 'btn-primary' }, 'Подтвердить');
    const form = h('form', { class: 'space-y-4' },
      h('ol', { class: 'list-decimal space-y-1 pl-5 text-sm' },
        h('li', {}, 'Установите приложение-аутентификатор: Яндекс Ключ, Google Authenticator, Aegis, 1Password…'),
        h('li', {}, 'Отсканируйте QR-код или введите ключ вручную.'),
        h('li', {}, 'Введите 6 цифр из приложения.')),
      h('div', { class: 'flex flex-col items-center gap-4 sm:flex-row sm:items-start' },
        qrCanvas(data.uri),
        h('div', { class: 'min-w-0 flex-1 space-y-3' },
          h('div', {}, h('p', { class: muted }, 'Ключ для ручного ввода'),
            h('code', { class: 'block break-all rounded-lg bg-slate-50 p-2 font-mono text-sm dark:bg-slate-950' }, data.secret.match(/.{1,4}/g).join(' '))),
          h('div', {}, h('label', { for: 'totp-code', class: 'mb-1.5 block text-sm font-medium' }, 'Код из приложения'), code),
          error)),
      h('div', { class: 'flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn-ghost', onclick: render }, 'Отмена'), confirm));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      confirm.disabled = true;
      error.classList.add('hidden');
      try {
        const { recoveryCodes } = await api.twoFactorEnable(code.value.trim());
        ctx.user.twoFactor = true;
        toast('Двухфакторная аутентификация включена', 'success');
        render();
        box.append(recoveryList(recoveryCodes));
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
        code.select();
      } finally {
        confirm.disabled = false;
      }
    });
    box.replaceChildren(form);
    code.focus();
  }

  async function disable() {
    const values = await passwordDialog('Выключить 2FA?', 'Для входа снова будет достаточно пароля.', 'Выключить', true);
    if (!values) return;
    try {
      await api.twoFactorDisable(values.password);
      ctx.user.twoFactor = false;
      toast('Двухфакторная аутентификация выключена', 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function newCodes() {
    const values = await passwordDialog('Новые коды восстановления', 'Старые коды перестанут работать.', 'Создать', false);
    if (!values) return;
    try {
      const { recoveryCodes } = await api.twoFactorRecovery(values.password);
      render();
      box.append(recoveryList(recoveryCodes));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  render();
  // После входа кодом восстановления — напомнить, сколько их осталось.
  const left = sessionStorage.getItem('fm-recovery-left');
  if (left !== null) {
    sessionStorage.removeItem('fm-recovery-left');
    toast(`Вы вошли по коду восстановления. Осталось кодов: ${left}`, Number(left) <= 2 ? 'error' : 'info');
  }
  return box;
}
