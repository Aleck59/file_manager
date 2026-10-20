const form = document.getElementById('login-form');

// Название и логотип, заданные администратором.
fetch('/api/branding').then((r) => r.json()).then((b) => {
  if (b.name) { document.getElementById('brand-name').textContent = b.name; document.title = `Вход — ${b.name}`; }
  if (b.logo) document.getElementById('brand-logo').src = b.logo;
}).catch(() => {});
const errorBox = document.getElementById('login-error');
const button = form.querySelector('button[type=submit]');
const toggle = document.getElementById('toggle-password');

// Показать/скрыть пароль — удобно на телефоне, где легко ошибиться при вводе.
toggle.addEventListener('click', () => {
  const show = form.password.type === 'password';
  form.password.type = show ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(show));
  const label = show ? 'Скрыть пароль' : 'Показать пароль';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  form.password.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.add('hidden');
  form.password.type = 'password';
  button.disabled = true;
  button.textContent = 'Проверяем…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.twoFactor) return showCodeStep(data.ticket);
      window.location.replace('/');
      return;
    }
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Ошибка ${res.status}`);
  } catch (err) {
    errorBox.textContent = err.message === 'Failed to fetch' ? 'Сервер недоступен' : err.message;
    errorBox.classList.remove('hidden');
    form.password.select();
  } finally {
    button.disabled = false;
    button.textContent = 'Войти';
  }
});

// ---------- второй шаг: код из приложения (2FA) ----------
const codeForm = document.getElementById('code-form');
const codeError = document.getElementById('code-error');
let ticket;

function showCodeStep(t) {
  ticket = t; // после входа через Яндекс/Google билет лежит в HttpOnly-cookie — тогда undefined
  form.classList.add('hidden');
  codeForm.classList.remove('hidden');
  codeForm.code.focus();
}

codeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  codeError.classList.add('hidden');
  const btn = codeForm.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login/2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, code: codeForm.code.value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    if (data.recoveryLeft !== undefined) sessionStorage.setItem('fm-recovery-left', String(data.recoveryLeft));
    window.location.replace('/');
  } catch (err) {
    codeError.textContent = err.message === 'Failed to fetch' ? 'Сервер недоступен' : err.message;
    codeError.classList.remove('hidden');
    codeForm.code.select();
  } finally {
    btn.disabled = false;
  }
});
// Код из 6 цифр — отправляем сразу, без нажатия кнопки.
codeForm.code.addEventListener('input', () => {
  if (/^\d{6}$/.test(codeForm.code.value.trim())) codeForm.requestSubmit();
});

// ---------- вход через Яндекс / Google ----------
const ICONS = { yandex: 'Я', google: 'G' };
fetch('/api/auth/oauth').then((r) => r.json()).then(({ providers }) => {
  if (!providers?.length) return;
  const box = document.getElementById('oauth-buttons');
  for (const p of providers) {
    const a = document.createElement('a');
    a.href = `/api/auth/oauth/${p.id}`;
    a.className = 'btn-ghost w-full border border-slate-200 dark:border-slate-700';
    const mark = document.createElement('span');
    mark.className = `flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold text-white ${p.id === 'yandex' ? 'bg-red-500' : 'bg-sky-600'}`;
    mark.textContent = ICONS[p.id] ?? '';
    a.append(mark, `Войти через ${p.name}`);
    box.append(a);
  }
  document.getElementById('oauth').classList.remove('hidden');
}).catch(() => {});

const ERRORS = {
  expired: 'Срок действия учётной записи истёк — обратитесь к администратору.',
  nouser: 'Нет пользователя с такой почтой. Попросите администратора указать вашу почту в профиле.',
  denied: 'Вход отменён.',
  expired: 'Время на вход истекло — попробуйте ещё раз.',
  state: 'Не удалось подтвердить вход — попробуйте ещё раз.',
  noemail: 'У аккаунта нет подтверждённой почты.',
  failed: 'Не удалось войти через провайдера. Попробуйте ещё раз или войдите по паролю.',
};
const params = new URLSearchParams(location.search);
if (params.get('error')) {
  errorBox.textContent = ERRORS[params.get('error')] ?? ERRORS.failed;
  errorBox.classList.remove('hidden');
}
if (params.get('step') === '2fa') showCodeStep();
history.replaceState(null, '', '/login');
