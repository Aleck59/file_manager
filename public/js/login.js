const form = document.getElementById('login-form');
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
