// Настройки администратора: все параметры .env, которые можно менять из интерфейса.
// Значения из .env остаются значениями по умолчанию; изменения хранятся на сервере
// в data/settings.json. Секреты в браузер не передаются — их можно только заменить.
import { api } from '../api.js';
import { detectPreset, S3_PRESETS } from '../s3-presets.js';
import { confirmDialog, h, icon, openDialog, toast } from '../ui.js';

const SOURCE = {
  env: ['.env', 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300', 'Значение из файла .env'],
  ui: ['изменено', 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300', 'Изменено в интерфейсе (data/settings.json)'],
  default: ['по умолчанию', 'bg-slate-50 text-slate-400 dark:bg-slate-900 dark:text-slate-500', 'Значение по умолчанию'],
};

function card(title, description, iconName, ...content) {
  return h('section', { class: 'card overflow-hidden' },
    h('div', { class: 'flex items-start gap-3 border-b border-slate-200 p-5 sm:px-6 dark:border-slate-800' },
      h('span', { class: 'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }, icon(iconName)),
      h('div', {},
        h('h3', { class: 'font-semibold' }, title),
        h('p', { class: 'mt-0.5 text-sm text-slate-500 dark:text-slate-400' }, description))),
    h('div', { class: 'space-y-5 p-5 sm:p-6' }, ...content));
}

const statusLine = () => h('p', { class: 'hidden text-sm', role: 'status' });
function setStatus(el, kind, text) {
  el.className = `flex items-start gap-1.5 text-sm ${kind === 'ok' ? 'text-brand-700 dark:text-brand-400' : kind === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500'}`;
  el.replaceChildren(...(kind === 'ok' ? [icon('check', 'mt-0.5 h-4 w-4')] : kind === 'error' ? [icon('alert', 'mt-0.5 h-4 w-4')] : []), h('span', {}, text));
}

/**
 * Поле формы, привязанное к настройке сервера.
 * @returns {{ el: HTMLElement, key: string, value: () => any, changed: () => boolean, input: HTMLElement }}
 */
function settingField(desc, { label, hint, suffix, placeholder, onReset, wide, inputType }) {
  const id = `set-${desc.key}`;
  const [srcLabel, srcTone, srcTitle] = SOURCE[desc.source];
  let input;
  if (desc.type === 'bool') {
    input = h('input', { id, type: 'checkbox', class: 'peer sr-only', checked: Boolean(desc.value) });
  } else {
    const isSecret = desc.type === 'secret';
    input = h('input', {
      id, class: `input ${suffix ? 'pr-14' : ''}`,
      type: isSecret ? 'password' : inputType ?? (desc.type === 'int' ? 'number' : 'text'),
      value: isSecret ? '' : String(desc.value ?? ''),
      placeholder: isSecret ? (desc.isSet ? '•••••••• задан (пусто — не менять)' : 'не задан') : placeholder ?? '',
      autocomplete: isSecret ? 'new-password' : 'off', spellcheck: 'false',
      min: desc.min, max: desc.max, inputmode: desc.type === 'int' ? 'numeric' : undefined,
    });
  }
  const initial = desc.type === 'bool' ? Boolean(desc.value) : desc.type === 'secret' ? '' : String(desc.value ?? '');
  const value = () => (desc.type === 'bool' ? input.checked : input.value.trim());
  const changed = () => (desc.type === 'secret' ? value() !== '' : value() !== initial);

  const head = h('div', { class: 'mb-1.5 flex flex-wrap items-center gap-2' },
    h('label', { for: id, class: 'text-sm font-medium' }, label),
    h('span', { class: `badge ${srcTone}`, title: srcTitle }, srcLabel),
    desc.apply === 'restart' && h('span', { class: 'badge bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300', title: 'Применяется после перезапуска приложения' }, desc.restartPending ? 'ждёт перезапуска' : 'после перезапуска'),
    desc.source === 'ui' && onReset && h('button', {
      type: 'button', class: 'ml-auto text-xs font-medium text-slate-500 hover:text-slate-900 hover:underline dark:hover:text-white',
      title: 'Вернуть значение из .env', onclick: () => onReset(desc.key),
    }, 'вернуть из .env'));

  let control;
  if (desc.type === 'bool') {
    control = h('label', { for: id, class: 'inline-flex cursor-pointer items-center gap-3' },
      input,
      h('span', { class: "relative h-6 w-11 rounded-full bg-slate-300 transition after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition after:content-[''] peer-checked:bg-brand-600 peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 dark:bg-slate-700" }),
      h('span', { class: 'text-sm text-slate-600 dark:text-slate-300' }, hint));
  } else {
    control = h('div', { class: 'relative' }, input,
      suffix && h('span', { class: 'pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400' }, suffix));
  }
  const el = h('div', { class: wide ? 'sm:col-span-2' : '' }, head, control,
    desc.type !== 'bool' && hint && h('p', { class: 'mt-1 text-xs text-slate-500 dark:text-slate-400' }, hint));
  return { el, key: desc.key, value, changed, input };
}

const changedValues = (fields) => Object.fromEntries(fields.filter((f) => f.changed()).map((f) => [f.key, f.value()]));

export function adminSettings(ctx) {
  const root = h('div', { class: 'space-y-6' },
    h('div', { class: 'h-64 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800' }));
  let data;

  async function load() {
    try {
      data = await api.getSettings();
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function applyResult(res, message) {
    data = res;
    ctx.setStorageConfigured?.(res.s3Configured);
    render();
    if (message) toast(message, 'success');
  }

  async function reset(key, opts = {}) {
    try {
      applyResult(await api.resetSettings([key], opts), 'Значение возвращено из .env');
    } catch (err) {
      if (err.status === 409 && key === 'APP_ORIGIN') {
        if (await confirmDialog('Вернуть адрес сайта из .env?', 'Если адрес изменится, дальше работать нужно будет по новому адресу.', 'Вернуть')) {
          return reset(key, { confirmOriginChange: true });
        }
        return;
      }
      toast(err.message, 'error');
    }
  }

  function render() {
    const f = Object.fromEntries(data.fields.map((x) => [x.key, x]));
    root.replaceChildren(storageCard(f), limitsCard(f), appCard(f), infoCard());
  }

  // ---------- Хранилище S3 ----------
  function storageCard(f) {
    const fields = {
      endpoint: settingField(f.S3_ENDPOINT, { label: 'Адрес (endpoint)', placeholder: 'https://s3.example.com', wide: true, onReset: reset, inputType: 'url' }),
      region: settingField(f.S3_REGION, { label: 'Регион', onReset: reset }),
      bucket: settingField(f.S3_BUCKET, { label: 'Бакет', placeholder: 'my-bucket', onReset: reset }),
      access: settingField(f.S3_ACCESS_KEY, { label: 'Access Key ID', onReset: reset }),
      secret: settingField(f.S3_SECRET_KEY, { label: 'Secret Access Key', onReset: reset }),
      prefix: settingField(f.S3_PREFIX, { label: 'Папка в бакете', hint: 'Все файлы хранятся под этим префиксом, например uploads/. Пусто — корень бакета. Смена префикса показывает другой набор файлов.', onReset: reset }),
      pathStyle: settingField(f.S3_FORCE_PATH_STYLE, { label: 'Адресация', hint: 'Path-style (endpoint/бакет) — нужна большинству S3-совместимых хранилищ', onReset: reset }),
    };
    const all = Object.values(fields);

    // Провайдер: подставляет endpoint, регион и адресацию.
    const hintBox = h('div', { class: 'hidden rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:bg-sky-950/50 dark:text-sky-200' });
    const showHint = (preset) => {
      hintBox.classList.toggle('hidden', !preset?.hint);
      hintBox.replaceChildren(h('span', { class: 'font-medium' }, `${preset?.name ?? ''}: `), preset?.hint ?? '');
      fields.access.input.placeholder = preset?.accessKeyPlaceholder ?? '';
    };
    const current = detectPreset(f.S3_ENDPOINT.value);
    const select = h('select', { id: 'set-preset', class: 'input', onchange: () => {
      const preset = S3_PRESETS.find((p) => p.id === select.value);
      if (!preset) return showHint(null);
      fields.endpoint.input.value = preset.endpoint;
      fields.region.input.value = preset.region;
      fields.pathStyle.input.checked = preset.pathStyle;
      showHint(preset);
      if (preset.endpoint.includes('<')) fields.endpoint.input.focus();
      else (fields.bucket.input.value ? fields.access.input : fields.bucket.input).focus();
    } },
    h('option', { value: '' }, 'Другой S3-совместимый провайдер'),
    S3_PRESETS.map((p) => h('option', { value: p.id, selected: p.id === current?.id }, p.name)));
    showHint(current);

    const status = statusLine();
    const saveBtn = h('button', { type: 'button', class: 'btn-primary', onclick: () => save() }, 'Сохранить');
    const checkBtn = h('button', { type: 'button', class: 'btn-ghost border border-slate-200 dark:border-slate-700', onclick: check }, icon('server'), 'Проверить подключение');
    const corsBtn = h('button', { type: 'button', class: 'btn-ghost border border-slate-200 dark:border-slate-700', onclick: cors, disabled: !data.s3Configured,
      title: 'Разрешить браузеру загружать и скачивать файлы с адреса этого сайта' }, icon('key'), 'Настроить CORS бакета');

    async function check() {
      checkBtn.disabled = true;
      setStatus(status, 'info', 'Проверяем подключение…');
      try {
        const r = await api.checkStorage(changedValues(all));
        setStatus(status, r.ok ? 'ok' : 'error', r.ok ? `Подключение в порядке · ${r.latencyMs} мс` : r.error);
      } catch (err) {
        setStatus(status, 'error', err.message);
      } finally {
        checkBtn.disabled = false;
      }
    }

    async function save(skipCheck = false) {
      const values = changedValues(all);
      if (!Object.keys(values).length) return setStatus(status, 'info', 'Изменений нет');
      saveBtn.disabled = true;
      setStatus(status, 'info', skipCheck ? 'Сохраняем…' : 'Проверяем подключение и сохраняем…');
      try {
        const res = await api.saveSettings(values, { skipCheck });
        const moved = res.changed.some((k) => k === 'S3_ENDPOINT' || k === 'S3_BUCKET');
        if (!moved) return applyResult(res, 'Настройки хранилища сохранены');

        // Новый бакет: сразу разрешаем браузеру доступ к нему (CORS)…
        let corsNote = 'CORS бакета настроен.';
        try {
          await api.applyCors();
        } catch {
          corsNote = 'CORS настроить не удалось — задайте его в панели провайдера (см. deploy/s3-cors.json).';
        }
        applyResult(res);
        // …и перезагружаем страницу: политика безопасности (CSP) браузера фиксируется
        // при загрузке страницы и должна разрешить обращения к новому адресу хранилища.
        toast(`Хранилище подключено. ${corsNote} Страница сейчас обновится…`, 'success');
        setTimeout(() => window.location.reload(), 2500);
      } catch (err) {
        setStatus(status, 'error', err.message);
        if (err.status === 422 && !skipCheck) {
          status.append(h('button', { type: 'button', class: 'ml-2 shrink-0 font-medium underline', onclick: () => save(true) }, 'Сохранить без проверки'));
        }
      } finally {
        saveBtn.disabled = false;
      }
    }

    async function cors() {
      corsBtn.disabled = true;
      try {
        const r = await api.applyCors();
        setStatus(status, 'ok', `CORS настроен: браузеру разрешён доступ с ${r.origin}`);
      } catch (err) {
        setStatus(status, 'error', err.message);
      } finally {
        corsBtn.disabled = false;
      }
    }

    return card('Хранилище S3', 'Где хранятся файлы. Новые параметры проверяются подключением перед сохранением.', 'server',
      !data.s3Configured && h('div', { class: 'flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-200' },
        icon('alert', 'mt-0.5 h-4 w-4'), 'Хранилище ещё не настроено — заполните параметры ниже, чтобы начать загружать файлы.'),
      h('div', {}, h('label', { for: 'set-preset', class: 'mb-1.5 block text-sm font-medium' }, 'Провайдер'), select),
      hintBox,
      h('div', { class: 'grid gap-4 sm:grid-cols-2' }, ...all.map((x) => x.el)),
      h('div', { class: 'flex flex-wrap items-center gap-2 border-t border-slate-200 pt-5 dark:border-slate-800' }, saveBtn, checkBtn, corsBtn),
      status);
  }

  // ---------- Лимиты загрузки ----------
  function limitsCard(f) {
    const fields = [
      settingField(f.MAX_FILE_SIZE_MB, { label: 'Максимальный размер файла', suffix: 'МБ', hint: '5120 МБ = 5 ГБ', onReset: reset }),
      settingField(f.MULTIPART_THRESHOLD_MB, { label: 'Загружать частями от', suffix: 'МБ', hint: 'Файлы крупнее грузятся частями параллельно (multipart)', onReset: reset }),
      settingField(f.MULTIPART_PART_SIZE_MB, { label: 'Размер части', suffix: 'МБ', hint: 'Не меньше 5 МБ — ограничение S3', onReset: reset }),
      settingField(f.UPLOAD_URL_TTL_MIN, { label: 'Ссылка на загрузку действует', suffix: 'мин', hint: 'Сколько времени есть у браузера, чтобы начать загрузку', onReset: reset }),
    ];
    return card('Загрузка файлов', 'Ограничения и параметры загрузки. Применяются сразу.', 'upload',
      h('div', { class: 'grid gap-4 sm:grid-cols-2' }, ...fields.map((x) => x.el)),
      saveRow(fields));
  }

  // ---------- Сайт и безопасность ----------
  function appCard(f) {
    const fields = [
      settingField(f.APP_ORIGIN, { label: 'Адрес сайта', wide: true, inputType: 'url', onReset: reset,
        hint: 'Публичный адрес, по которому открывают файлообменник (https://…). Используется для защиты от CSRF и в правилах CORS бакета.' }),
      settingField(f.SESSION_TTL_HOURS, { label: 'Длительность сессии', suffix: 'ч', hint: 'Через сколько часов нужно войти заново', onReset: reset }),
      settingField(f.TRUST_PROXY, { label: 'Прокси перед приложением', hint: 'Сколько прокси (Nginx и др.) стоит перед Node.js — для определения IP клиента. FastPanel: 1', onReset: reset }),
      settingField(f.HOST, { label: 'Адрес прослушивания (HOST)', hint: '127.0.0.1 — доступ только через Nginx (рекомендуется)', onReset: reset }),
      settingField(f.PORT, { label: 'Порт (PORT)', hint: 'Должен совпадать с proxy_pass в Nginx', onReset: reset }),
    ];
    const pending = data.fields.some((x) => x.restartPending);
    const restartBtn = h('button', { type: 'button', class: 'btn-ghost border border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300', onclick: restart }, icon('refresh'), 'Перезапустить приложение');

    async function restart() {
      const ok = await confirmDialog('Перезапустить приложение?',
        data.supervised
          ? 'Процесс завершится и будет запущен заново менеджером процессов. Это займёт несколько секунд; загрузки в браузерах продолжатся.'
          : 'Похоже, приложение запущено не через PM2/systemd/FastPanel — после завершения его некому будет запустить снова. Продолжайте, только если уверены.',
        'Перезапустить');
      if (!ok) return;
      await api.restart().catch(() => {});
      toast('Перезапуск… страница обновится через несколько секунд');
      setTimeout(() => window.location.reload(), 4000);
    }

    async function resetSessions() {
      if (!(await confirmDialog('Завершить все сессии?', 'Будет создан новый секрет сессий. Все пользователи на всех устройствах выйдут из системы; вы останетесь в ней.', 'Завершить'))) return;
      try {
        await api.resetSessions();
        toast('Все сессии завершены', 'success');
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    return card('Сайт и безопасность', 'Адрес сайта, сессии и параметры запуска.', 'settings',
      h('div', { class: 'grid gap-4 sm:grid-cols-2' }, ...fields.map((x) => x.el)),
      saveRow(fields, { originField: fields[0] }),
      h('div', { class: 'flex flex-wrap items-center gap-2 border-t border-slate-200 pt-5 dark:border-slate-800' },
        h('button', { type: 'button', class: 'btn-ghost border border-slate-200 text-rose-600 dark:border-slate-700 dark:text-rose-400', onclick: resetSessions }, icon('logout'), 'Завершить все сессии'),
        pending && restartBtn,
        pending && h('span', { class: 'text-sm text-amber-700 dark:text-amber-300' }, 'Изменения HOST/PORT вступят в силу после перезапуска')));
  }

  function saveRow(fields, { originField } = {}) {
    const status = statusLine();
    const btn = h('button', { type: 'button', class: 'btn-primary', onclick: async () => {
      const values = changedValues(fields);
      if (!Object.keys(values).length) return setStatus(status, 'info', 'Изменений нет');
      const opts = {};
      if (originField && values.APP_ORIGIN !== undefined) {
        const ok = await confirmDialog('Сменить адрес сайта?',
          `После сохранения изменять что-либо можно будет только с адреса ${values.APP_ORIGIN}. Убедитесь, что он открывается (DNS, SSL, Nginx), и затем перенастройте CORS бакета.`,
          'Сменить адрес');
        if (!ok) return;
        opts.confirmOriginChange = true;
      }
      btn.disabled = true;
      try {
        const res = await api.saveSettings(values, opts);
        applyResult(res, 'Настройки сохранены');
        if (opts.confirmOriginChange) {
          await openDialog({ title: 'Адрес сайта изменён', text: `Откройте файлообменник по новому адресу: ${values.APP_ORIGIN}`, confirmLabel: 'Перейти' })
            .then((go) => { if (go) window.location.assign(values.APP_ORIGIN); });
        }
      } catch (err) {
        setStatus(status, 'error', err.message);
      } finally {
        btn.disabled = false;
      }
    } }, 'Сохранить');
    return h('div', { class: 'space-y-3' }, h('div', {}, btn), status);
  }

  // ---------- Служебное ----------
  function infoCard() {
    const row = (k, v) => h('div', { class: 'flex flex-col justify-between gap-1 py-2.5 sm:flex-row sm:gap-4' },
      h('dt', { class: 'text-slate-500 dark:text-slate-400' }, k),
      h('dd', { class: 'min-w-0 break-all font-medium sm:text-right' }, v));
    return card('Служебные сведения', 'Задаются только в .env на сервере.', 'drive',
      h('dl', { class: 'divide-y divide-slate-100 text-sm dark:divide-slate-800' },
        row('Каталог данных (DATA_DIR)', data.readonly.DATA_DIR),
        row('Файл настроек', data.readonly.settingsFile),
        row('Первый администратор (ADMIN_USERNAME)', `${data.readonly.ADMIN_USERNAME} — используется только при первом запуске`),
        row('Память процесса', `${data.memory.rssMb} МБ`),
        row('Перезапуск из интерфейса', data.supervised ? 'доступен (обнаружен менеджер процессов)' : 'менеджер процессов не обнаружен')));
  }

  load();
  return root;
}
