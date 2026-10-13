// Настройки администратора: все параметры .env, которые можно менять из интерфейса.
// Значения из .env остаются значениями по умолчанию; изменения хранятся на сервере
// в data/settings.json. Секреты в браузер не передаются — их можно только заменить.
import { api } from '../api.js';
import { detectPreset, S3_PRESETS, STORAGE_CLASS_LABELS, storageClassesFor } from '../s3-presets.js';
import { confirmDialog, FILES, formatDateShort, formatSize, h, icon, openDialog, pluralize, toast } from '../ui.js';

const OBJECTS = { one: 'объект', few: 'объекта', many: 'объектов', other: 'объекта' };

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
    ctx.setStorages?.(res.storages);
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
    root.replaceChildren(storagesCard(), limitsCard(f), usersCard(f), appCard(f), brandCard(f), backupCard(), transferCard(), infoCard());
  }

  // ---------- Хранилища (единый диск) ----------
  function storagesCard() {
    const list = data.storages;
    const usage = h('div');
    const placementSelect = h('select', { id: 'set-placement', class: 'input', disabled: list.length < 2,
      onchange: async () => {
        try {
          applyResult(await api.setPlacement(placementSelect.value), 'Политика размещения сохранена');
        } catch (err) {
          toast(err.message, 'error');
        }
      } },
    h('option', { value: 'fill', selected: data.placement === 'fill' }, 'По порядку — заполнять хранилища по очереди (с учётом квот)'),
    h('option', { value: 'balance', selected: data.placement === 'balance' }, 'Балансировка — в наименее заполненное хранилище'));

    const stats = {};
    if (list.length) {
      api.stats().then((s) => {
        for (const x of s.storages ?? []) stats[x.id] = x;
        for (const el of usage.closest('section')?.querySelectorAll('[data-usage]') ?? []) {
          const x = stats[el.dataset.usage];
          if (!x) continue;
          // Реальное место в бакете (включая объекты других программ) и доля файлообменника.
          el.textContent = x.error ? `недоступно: ${x.error}`
            : `В бакете: ${formatSize(x.bucketSize ?? x.size)}${x.quota ? ` из ${formatSize(x.quota)}` : ''}`
              + ` (${pluralize(x.bucketObjects ?? x.files, OBJECTS)}${x.complete ? '' : '+'})`
              + ` · файлообменник: ${formatSize(x.size)}, ${pluralize(x.files, FILES)}`;
          el.classList.toggle('text-rose-600', Boolean(x.error));
        }
      }).catch(() => {});
    }

    const move = async (i, dir) => {
      const ids = list.map((x) => x.id);
      [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
      try {
        applyResult(await api.reorderStorages(ids));
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    const row = (st, i) => {
      const status = h('p', { class: 'mt-1 text-xs text-slate-500 dark:text-slate-400', role: 'status' });
      const action = (iconName, label, onclick, extra = '') => h('button', { type: 'button', class: `icon-btn ${extra}`, title: label, 'aria-label': `${label}: ${st.name}`, onclick }, icon(iconName));
      return h('li', { class: 'flex flex-wrap items-start gap-3 py-4 first:pt-0 last:pb-0' },
        h('span', { class: 'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400', title: 'Порядок' }, String(i + 1)),
        h('div', { class: 'min-w-0 flex-1' },
          h('p', { class: 'flex flex-wrap items-center gap-2 font-medium' }, st.name,
            st.acceptUploads
              ? h('span', { class: 'badge bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300' }, 'принимает файлы')
              : h('span', { class: 'badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }, 'только чтение'),
            st.quotaGb > 0 && h('span', { class: 'badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }, `квота ${st.quotaGb} ГБ`),
            st.storageClass && h('span', { class: 'badge bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300', title: 'Класс хранения новых файлов' }, st.storageClass)),
          h('p', { class: 'truncate text-sm text-slate-500 dark:text-slate-400', title: `${st.endpoint} · ${st.bucket}/${st.prefix}` },
            `${detectPreset(st.endpoint)?.name ?? new URL(st.endpoint).host} · ${st.bucket}/${st.prefix}`),
          h('p', { class: 'mt-0.5 text-xs tabular-nums text-slate-500 dark:text-slate-400', dataset: { usage: st.id } }, ' '),
          status),
        h('div', { class: 'flex shrink-0 gap-0.5' },
          list.length > 1 && action('chevronRight', 'Выше', () => move(i, -1), `-rotate-90 ${i === 0 ? 'invisible' : ''}`),
          list.length > 1 && action('chevronRight', 'Ниже', () => move(i, 1), `rotate-90 ${i === list.length - 1 ? 'invisible' : ''}`),
          action('upload', 'Проверить загрузку из браузера', () => diagnose(st)),
          action('server', 'Проверить подключение', async () => {
            setStatus(status, 'info', 'Проверяем…');
            const r = await api.checkStorage({}, st.id).catch((err) => ({ ok: false, error: err.message }));
            setStatus(status, r.ok ? 'ok' : 'error', r.ok ? `Подключение в порядке · ${r.latencyMs} мс` : r.error);
          }),
          action('key', 'Настроить CORS бакета', async () => {
            try {
              const r = await api.applyCors(st.id);
              setStatus(status, 'ok', `CORS настроен для ${r.origin}`);
            } catch (err) {
              setStatus(status, 'error', err.message);
            }
          }),
          action('pencil', 'Изменить', () => editStorage(st)),
          action('trash', 'Отключить', () => removeStorage(st), 'icon-btn-danger')));
    };

    return card('Хранилища', 'S3-хранилища, объединённые в один диск. Папки общие, каждый файл лежит в одном из бакетов.', 'server',
      !list.length && h('div', { class: 'flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-200' },
        icon('alert', 'mt-0.5 h-4 w-4'), 'Не подключено ни одного хранилища — добавьте первое, чтобы начать загружать файлы.'),
      list.length > 0 && h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' }, list.map(row)),
      usage,
      h('div', {}, h('button', { type: 'button', class: 'btn-primary', onclick: () => editStorage(null) }, icon('plus'), 'Добавить хранилище')),
      h('div', { class: 'border-t border-slate-200 pt-5 dark:border-slate-800' },
        h('label', { for: 'set-placement', class: 'mb-1.5 block text-sm font-medium' }, 'Куда загружать новые файлы'),
        placementSelect,
        h('p', { class: 'mt-1 text-xs text-slate-500 dark:text-slate-400' },
          list.length < 2 ? 'Имеет смысл, когда хранилищ несколько.'
            : 'Хранилища «только чтение» и с исчерпанной квотой новые файлы не получают. Переименование и перемещение выполняются внутри бакета, где лежит файл.')));
  }

  // Диагностика: проверки сервера + пробная загрузка крошечного файла из этого браузера
  // тем же способом, что и обычные файлы. Объясняет, что именно мешает загрузке.
  async function diagnose(st) {
    const list = h('ul', { class: 'space-y-2 text-sm' });
    const close = h('button', { type: 'button', class: 'btn-primary', onclick: () => dialog.close() }, 'Готово');
    // Записать в бакет правила CORS приложения (с явными заголовками) и проверить заново.
    const fix = h('button', { type: 'button', class: 'btn-ghost', hidden: true }, icon('key'), 'Исправить правила CORS');
    fix.onclick = async () => {
      fix.disabled = true;
      try {
        await api.applyCors(st.id);
        toast('Правила CORS записаны в бакет');
        await run();
      } catch (err) {
        add(false, `Хранилище не приняло правила CORS: ${err.message}`,
          `Задайте их в консоли бакета: Источник = ${location.origin}, методы GET, PUT, HEAD, заголовки запроса: content-type, x-amz-storage-class, заголовки ответа: ETag.`);
      } finally {
        fix.disabled = false;
      }
    };
    const dialog = h('dialog', { class: 'w-[min(36rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' },
      h('div', { class: 'space-y-4 p-6' },
        h('h3', { class: 'text-lg font-semibold' }, `Проверка загрузки: «${st.name}»`),
        list,
        h('div', { class: 'flex flex-wrap justify-end gap-2' }, fix, close)));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();

    const add = (ok, text, hint) => {
      const tone = ok === true ? 'text-brand-700 dark:text-brand-400' : ok === false ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500';
      const li = h('li', { class: `flex items-start gap-2 ${tone}` },
        icon(ok === true ? 'check' : ok === false ? 'alert' : 'clock', 'mt-0.5 h-4 w-4'),
        h('span', {}, h('span', { class: 'block' }, text), hint && h('span', { class: 'mt-0.5 block text-xs text-slate-500 dark:text-slate-400' }, hint)));
      list.append(li);
      return li;
    };

    async function run() {
      list.replaceChildren();
      fix.hidden = true;
      let r;
      try {
        r = await api.diagnoseStorage(st.id);
      } catch (err) {
        return add(false, err.message);
      }
      let corsWarning = null;
      for (const c of r.checks) {
        const li = add(c.ok, c.text);
        if (c.id === 'cors' && c.ok === false) corsWarning = li;
        if ((c.id === 'cors' || c.id === 'preflight') && c.ok === false) fix.hidden = false;
      }
      if (!r.test) return add(false, 'Пробная загрузка из браузера невозможна, пока сервер не подключается к бакету.');

      // Пробная загрузка. Нарушение CSP браузер сообщает событием — так отличаем его от CORS.
      let cspBlocked = false;
      const onCsp = () => { cspBlocked = true; };
      document.addEventListener('securitypolicyviolation', onCsp);
      const result = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', r.test.url);
        for (const [k, v] of Object.entries(r.test.headers)) xhr.setRequestHeader(k, v);
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
        xhr.onerror = () => resolve({ status: 0 });
        xhr.send('ok');
      });
      document.removeEventListener('securitypolicyviolation', onCsp);

      if (result.status >= 200 && result.status < 300) {
        add(true, 'Браузер загружает файлы в хранилище — всё работает.',
          r.storageClass ? `Класс хранения ${r.storageClass} принят хранилищем.` : null);
        // Некоторые хранилища без правил CORS пускают любой сайт — тогда это не ошибка.
        corsWarning?.remove();
        api.cleanupDiagnose(st.id, r.test.key).catch(() => {});
        return;
      }
      if (result.status === 0) {
        if (cspBlocked) {
          return add(false, 'Обращение к хранилищу заблокировала политика безопасности страницы.',
            'Страница была открыта до подключения этого хранилища. Обновите её (Ctrl+F5) и проверьте снова.');
        }
        if (location.protocol === 'https:' && r.test.url.startsWith('http:')) {
          return add(false, 'Браузер заблокировал смешанный контент (сайт https, хранилище http).', 'Укажите endpoint хранилища с https://.');
        }
        if (r.checks.some((c) => c.id === 'preflight' && c.ok === false)) {
          return add(false, 'Браузер не получил разрешения CORS от бакета — причина указана выше.',
            'Нажмите «Исправить правила CORS» ниже — приложение запишет правила с явными заголовками и проверит снова.');
        }
        return add(false, 'Браузер не получил разрешения CORS от бакета — поэтому загрузки падают с «Нет ответа от S3».',
          `Нажмите «Исправить правила CORS» ниже. Если провайдер не принимает правила через API, задайте их в консоли бакета: Источник = ${r.origin}, методы GET, PUT, HEAD, заголовки запроса: content-type, x-amz-storage-class, заголовки ответа: ETag.`);
      }
      const code = result.body?.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? `HTTP ${result.status}`;
      const hints = {
        AccessDenied: 'У ключа нет права записи в бакет (или запись запрещена политикой бакета).',
        SignatureDoesNotMatch: 'Хранилище не приняло подпись ссылки: проверьте регион, Secret Key и способ адресации (path-style).',
        InvalidStorageClass: 'Хранилище не поддерживает выбранный класс хранения — выберите другой или «Класс бакета по умолчанию».',
        InvalidArgument: 'Хранилище отклонило параметры загрузки: если в тексте ошибки есть «request time», расходятся часы сервера (sudo timedatectl set-ntp true), иначе попробуйте класс хранения «по умолчанию».',
        RequestTimeTooSkewed: 'Часы сервера расходятся с хранилищем — включите синхронизацию времени: sudo timedatectl set-ntp true.',
      };
      add(false, `Хранилище отклонило загрузку: ${code}.`, hints[code] ?? 'Подробности — в консоли провайдера.');
    }

    run();
  }

  async function removeStorage(st) {
    const ok = await confirmDialog(`Отключить «${st.name}»?`,
      'Хранилище будет убрано из диска: его файлы перестанут отображаться, но останутся в бакете. Подключив его снова с теми же параметрами, вы вернёте их.',
      'Отключить');
    if (!ok) return;
    try {
      applyResult(await api.removeStorage(st.id), 'Хранилище отключено');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Окно добавления / изменения хранилища.
  function editStorage(st) {
    const isNew = !st;
    const v = st ?? { name: '', endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', forcePathStyle: true, prefix: 'uploads/', quotaGb: 0, acceptUploads: true, storageClass: '', hasSecret: false };
    const input = (name, label, { wide, hint, ...attrs } = {}) => {
      const el = h('input', { id: `st-${name}`, name, class: 'input', autocomplete: 'off', spellcheck: 'false', ...attrs });
      el.value = attrs.type === 'password' ? '' : String(v[name] ?? '');
      return { el, wrap: h('div', { class: wide ? 'sm:col-span-2' : '' }, h('label', { for: `st-${name}`, class: 'mb-1.5 block text-sm font-medium' }, label), el,
        hint && h('p', { class: 'mt-1 text-xs text-slate-500 dark:text-slate-400' }, hint)) };
    };
    const toggle = (name, label) => {
      const el = h('input', { id: `st-${name}`, type: 'checkbox', class: 'peer sr-only', checked: Boolean(v[name]) });
      return { el, wrap: h('label', { for: `st-${name}`, class: 'inline-flex cursor-pointer items-center gap-3' }, el,
        h('span', { class: "relative h-6 w-11 shrink-0 rounded-full bg-slate-300 transition after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition after:content-[''] peer-checked:bg-brand-600 peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 dark:bg-slate-700" }),
        h('span', { class: 'text-sm' }, label)) };
    };
    const f = {
      name: input('name', 'Название', { wide: true, placeholder: 'Например: Cloud.ru — архив', maxlength: 60 }),
      endpoint: input('endpoint', 'Адрес (endpoint)', { wide: true, type: 'url', placeholder: 'https://s3.example.com' }),
      region: input('region', 'Регион'),
      bucket: input('bucket', 'Бакет', { placeholder: 'my-bucket' }),
      accessKeyId: input('accessKeyId', 'Access Key ID'),
      secretAccessKey: input('secretAccessKey', 'Secret Access Key', { type: 'password', autocomplete: 'new-password',
        placeholder: v.hasSecret ? '•••••••• задан (пусто — не менять)' : '' }),
      prefix: input('prefix', 'Папка в бакете', { hint: 'Например uploads/. Пусто — корень бакета. При смене папки файлы из прежней остаются в бакете, но в диске не видны.' }),
      quotaGb: input('quotaGb', 'Квота, ГБ', { type: 'number', min: 0, hint: '0 — без ограничения. При заполнении новые файлы пойдут в другие хранилища.' }),
      forcePathStyle: toggle('forcePathStyle', 'Path-style адресация (нужна большинству S3-совместимых хранилищ)'),
      acceptUploads: toggle('acceptUploads', 'Принимать новые файлы (выключите, чтобы хранилище было только для чтения)'),
    };

    const hintBox = h('div', { class: 'hidden rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-800 sm:col-span-2 dark:bg-sky-950/50 dark:text-sky-200' });
    const showHint = (preset) => {
      hintBox.classList.toggle('hidden', !preset?.hint);
      hintBox.replaceChildren(h('span', { class: 'font-medium' }, `${preset?.name ?? ''}: `), preset?.hint ?? '');
      f.accessKeyId.el.placeholder = preset?.accessKeyPlaceholder ?? '';
    };
    const current = detectPreset(v.endpoint);
    // Класс хранения новых файлов: варианты зависят от провайдера.
    const classSel = h('select', { id: 'st-storageClass', class: 'input' });
    const fillClasses = (p, value) => {
      classSel.replaceChildren(...storageClassesFor(p, value).map((c) => h('option', { value: c, selected: c === value }, STORAGE_CLASS_LABELS[c] ?? c)));
    };
    fillClasses(current, v.storageClass ?? '');
    const classWrap = h('div', { class: 'sm:col-span-2' },
      h('label', { for: 'st-storageClass', class: 'mb-1.5 block text-sm font-medium' }, 'Класс хранения новых файлов'), classSel,
      h('p', { class: 'mt-1 text-xs text-slate-500 dark:text-slate-400' }, 'Передаётся заголовком X-Amz-Storage-Class при загрузке и сохраняется при переименовании/перемещении. Уже загруженные файлы не меняются.'));
    const preset = h('select', { id: 'st-preset', class: 'input', onchange: () => {
      const p = S3_PRESETS.find((x) => x.id === preset.value);
      showHint(p);
      if (!p) return;
      f.endpoint.el.value = p.endpoint;
      f.region.el.value = p.region;
      f.forcePathStyle.el.checked = p.pathStyle;
      fillClasses(p, p.defaultClass ?? '');
      if (!f.name.el.value.trim()) f.name.el.value = p.name;
      (p.endpoint.includes('<') ? f.endpoint.el : f.bucket.el).focus();
    } },
    h('option', { value: '' }, 'Другой S3-совместимый провайдер'),
    S3_PRESETS.map((p) => h('option', { value: p.id, selected: p.id === current?.id }, p.name)));
    showHint(current);

    const values = () => ({
      name: f.name.el.value.trim(),
      endpoint: f.endpoint.el.value.trim(),
      region: f.region.el.value.trim(),
      bucket: f.bucket.el.value.trim(),
      accessKeyId: f.accessKeyId.el.value.trim(),
      secretAccessKey: f.secretAccessKey.el.value.trim(),
      prefix: f.prefix.el.value.trim(),
      quotaGb: f.quotaGb.el.value.trim() || '0',
      forcePathStyle: f.forcePathStyle.el.checked,
      acceptUploads: f.acceptUploads.el.checked,
      storageClass: classSel.value,
    });

    const status = statusLine();
    const save = h('button', { type: 'submit', class: 'btn-primary' }, isNew ? 'Добавить' : 'Сохранить');
    const check = h('button', { type: 'button', class: 'btn-ghost border border-slate-200 dark:border-slate-700', onclick: async () => {
      check.disabled = true;
      setStatus(status, 'info', 'Проверяем подключение…');
      const r = await api.checkStorage(values(), st?.id).catch((err) => ({ ok: false, error: err.message }));
      setStatus(status, r.ok ? 'ok' : 'error', r.ok ? `Подключение в порядке · ${r.latencyMs} мс` : r.error);
      check.disabled = false;
    } }, icon('server'), 'Проверить');

    const form = h('form', { class: 'space-y-5 p-6', novalidate: true },
      h('h3', { class: 'text-lg font-semibold' }, isNew ? 'Новое хранилище' : `Хранилище «${st.name}»`),
      h('div', { class: 'grid gap-4 sm:grid-cols-2' },
        h('div', { class: 'sm:col-span-2' }, h('label', { for: 'st-preset', class: 'mb-1.5 block text-sm font-medium' }, 'Провайдер'), preset),
        hintBox,
        ...['name', 'endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'prefix', 'quotaGb'].map((k) => f[k].wrap),
        classWrap,
        h('div', { class: 'space-y-3 sm:col-span-2' }, f.forcePathStyle.wrap, f.acceptUploads.wrap)),
      status,
      h('div', { class: 'flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-5 dark:border-slate-800' },
        check,
        h('button', { type: 'button', class: 'btn-ghost', onclick: () => dialog.close() }, 'Отмена'),
        save));
    const dialog = h('dialog', { class: 'max-h-[calc(100dvh-2rem)] w-[min(40rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' }, form);

    async function submit(skipCheck) {
      save.disabled = true;
      setStatus(status, 'info', skipCheck ? 'Сохраняем…' : 'Проверяем подключение и сохраняем…');
      try {
        const res = isNew ? await api.addStorage(values(), { skipCheck }) : await api.updateStorage(st.id, values(), { skipCheck });
        dialog.close();
        applyResult(res);
        if (res.cors) {
          // Новый адрес хранилища: браузер должен заново получить политику безопасности (CSP),
          // разрешающую обращения к нему, — перезагружаем страницу.
          toast(`Хранилище «${res.storage.name}» ${isNew ? 'подключено' : 'сохранено'}. ${res.cors.ok ? 'CORS бакета настроен.' : res.cors.error} Страница сейчас обновится…`, res.cors.ok ? 'success' : 'error');
          setTimeout(() => window.location.reload(), 2500);
        } else {
          toast('Хранилище сохранено', 'success');
        }
      } catch (err) {
        setStatus(status, 'error', err.message);
        if (err.status === 422 && !skipCheck) {
          status.append(h('button', { type: 'button', class: 'ml-2 shrink-0 font-medium underline', onclick: () => submit(true) }, 'Сохранить без проверки'));
        }
      } finally {
        save.disabled = false;
      }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    (isNew ? preset : f.name.el).focus();
  }

  // ---------- Лимиты загрузки ----------
  function limitsCard(f) {
    const fields = [
      settingField(f.MAX_FILE_SIZE_MB, { label: 'Максимальный размер файла', suffix: 'МБ', hint: '5120 МБ = 5 ГБ', onReset: reset }),
      settingField(f.MULTIPART_THRESHOLD_MB, { label: 'Загружать частями от', suffix: 'МБ', hint: 'Файлы крупнее грузятся частями параллельно (multipart)', onReset: reset }),
      settingField(f.MULTIPART_PART_SIZE_MB, { label: 'Размер части', suffix: 'МБ', hint: 'Не меньше 5 МБ — ограничение S3', onReset: reset }),
      settingField(f.UPLOAD_URL_TTL_MIN, { label: 'Ссылка на загрузку действует', suffix: 'мин', hint: 'Сколько времени есть у браузера, чтобы начать загрузку', onReset: reset }),
      settingField(f.TRASH_DAYS, { label: 'Хранить в корзине', suffix: 'дн.', hint: 'Удалённое можно восстановить в течение этого срока. 0 — удалять сразу, без корзины', onReset: reset }),
    ];
    return card('Загрузка файлов', 'Ограничения и параметры загрузки. Применяются сразу.', 'upload',
      h('div', { class: 'grid gap-4 sm:grid-cols-2' }, ...fields.map((x) => x.el)),
      saveRow(fields));
  }

  // ---------- Пользователи и вход ----------
  function usersCard(f) {
    const origin = f.APP_ORIGIN.value || location.origin;
    const cb = (id) => `${origin}/api/auth/oauth/${id}/callback`;
    const fields = [
      settingField(f.WEBDAV_ENABLED, { label: 'WebDAV', hint: `Диск как сетевая папка: ${origin}/dav/ — логин и пароль (с 2FA — API-токен вместо пароля)`, onReset: reset, wide: true }),
      settingField(f.PERSONAL_FOLDERS, { label: 'Личные папки', hint: 'У каждого пользователя своя папка, которую видит только он (и администраторы)', onReset: reset }),
      settingField(f.PERSONAL_ROOT, { label: 'Где лежат личные папки', hint: 'Папка в корне диска: «Личные/<логин>/»', onReset: reset }),
      settingField(f.OAUTH_YANDEX_ID, { label: 'Яндекс ID: ClientID', hint: `oauth.yandex.ru → создать приложение, доступ «login:email». Redirect URI: ${cb('yandex')}`, onReset: reset, wide: true }),
      settingField(f.OAUTH_YANDEX_SECRET, { label: 'Яндекс ID: Client secret', onReset: reset, wide: true }),
      settingField(f.OAUTH_GOOGLE_ID, { label: 'Google: Client ID', hint: `console.cloud.google.com → Credentials → OAuth client (Web). Authorized redirect URI: ${cb('google')}`, onReset: reset, wide: true }),
      settingField(f.OAUTH_GOOGLE_SECRET, { label: 'Google: Client secret', onReset: reset, wide: true }),
    ];
    return card('Пользователи и вход', 'Личные папки и вход через Яндекс/Google. Через провайдера входят только существующие пользователи — по почте, указанной в разделе «Пользователи».', 'users',
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
        if (values.APP_NAME !== undefined) api.branding().then((b) => window.dispatchEvent(new CustomEvent('fm-branding', { detail: b }))).catch(() => {});
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

  // ---------- Название и логотип ----------
  function brandCard(f) {
    const name = settingField(f.APP_NAME, { label: 'Название', wide: true, onReset: reset,
      hint: 'Показывается в левой панели, на странице входа и в заголовке вкладки.' });
    const img = h('img', { alt: '', class: 'h-12 w-12 rounded-xl object-contain' });
    const status = statusLine();
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'sr-only', id: 'logo-input' });
    const removeBtn = h('button', { type: 'button', class: 'btn-ghost', onclick: removeLogo }, icon('trash'), 'Стандартный');
    const show = (b) => {
      img.src = b.logo ?? '/favicon.svg';
      removeBtn.classList.toggle('hidden', !b.logo);
      window.dispatchEvent(new CustomEvent('fm-branding', { detail: b }));
    };
    api.branding().then(show).catch(() => {});
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      if (file.size > 256 * 1024) return setStatus(status, 'error', 'Логотип больше 256 КБ');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      try {
        show(await api.uploadLogo(btoa(bin)));
        setStatus(status, 'ok', 'Логотип обновлён');
      } catch (err) {
        setStatus(status, 'error', err.message);
      }
    });
    async function removeLogo() {
      try {
        show(await api.removeLogo());
        setStatus(status, 'ok', 'Возвращён стандартный значок');
      } catch (err) {
        setStatus(status, 'error', err.message);
      }
    }
    return card('Название и логотип', 'Как называется файлообменник для пользователей.', 'image',
      h('div', { class: 'grid gap-4 sm:grid-cols-2' }, name.el),
      h('div', {},
        h('p', { class: 'mb-1.5 text-sm font-medium' }, 'Логотип'),
        h('div', { class: 'flex flex-wrap items-center gap-3' },
          h('span', { class: 'flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800' }, img),
          h('label', { for: 'logo-input', class: 'btn-ghost cursor-pointer border border-slate-200 dark:border-slate-700' }, icon('upload'), 'Загрузить'),
          input, removeBtn),
        h('p', { class: 'mt-1 text-xs text-slate-500 dark:text-slate-400' }, 'PNG, JPEG или WebP до 256 КБ, лучше квадратный. SVG не принимается: в нём может быть скрипт.'),
        status),
      saveRow([name]));
  }

  // ---------- Перенос настроек ----------
  function transferCard() {
    const withSecrets = h('input', { type: 'checkbox', id: 'export-secrets', class: 'check' });
    const status = statusLine();
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-input' });
    async function doExport() {
      try {
        const res = await fetch(`/api/settings/export${withSecrets.checked ? '?secrets=1' : ''}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Ошибка ${res.status}`);
        const url = URL.createObjectURL(await res.blob());
        const a = h('a', { href: url, download: `file-manager-settings-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus(status, 'ok', withSecrets.checked ? 'Файл скачан. В нём ключи S3 — храните его как пароль.' : 'Файл скачан (без ключей S3).');
      } catch (err) {
        setStatus(status, 'error', err.message);
      }
    }
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        return setStatus(status, 'error', 'Файл не похож на JSON');
      }
      const ok = await confirmDialog('Применить настройки из файла?',
        'Параметры загрузки, сессий и хранилищ будут заменены значениями из файла. Адрес сайта и секрет сессий не меняются. Хранилища без ключа в файле не добавляются.', 'Применить');
      if (!ok) return;
      try {
        const res = await api.importSettings(data);
        const r = res.report;
        const parts = [];
        if (r.settings.length) parts.push(`настройки: ${r.settings.join(', ')}`);
        if (r.updated.length) parts.push(`обновлены хранилища: ${r.updated.join(', ')}`);
        if (r.added.length) parts.push(`добавлены: ${r.added.join(', ')}`);
        if (r.skipped.length) parts.push(`без ключа, пропущены: ${r.skipped.join(', ')}`);
        setStatus(status, r.skipped.length ? 'info' : 'ok', parts.length ? `Готово — ${parts.join('; ')}.` : 'Изменений нет.');
        if (r.added.length || r.updated.length) {
          toast('Хранилища изменены — страница обновится', 'success');
          setTimeout(() => window.location.reload(), 2500);
        }
      } catch (err) {
        setStatus(status, 'error', err.message);
      }
    });
    return card('Перенос настроек', 'Файл с настройками — для переноса на другой сервер или резервной копии.', 'download',
      h('div', { class: 'flex flex-wrap items-center gap-3' },
        h('button', { type: 'button', class: 'btn-ghost border border-slate-200 dark:border-slate-700', onclick: doExport }, icon('download'), 'Скачать настройки'),
        h('label', { for: 'export-secrets', class: 'flex items-center gap-2 text-sm' }, withSecrets, 'с ключами доступа S3'),
        h('span', { class: 'flex-1' }),
        h('label', { for: 'import-input', class: 'btn-ghost cursor-pointer border border-slate-200 dark:border-slate-700' }, icon('upload'), 'Загрузить из файла'),
        fileInput),
      h('p', { class: 'text-xs text-slate-500 dark:text-slate-400' },
        'Без ключей: на новом сервере обновятся параметры уже подключённых хранилищ. С ключами — хранилища подключатся полностью; такой файл храните как пароль. Пользователи и пароли не переносятся (файл data/users.json).'),
      status);
  }

  // ---------- Резервное копирование ----------
  function backupCard() {
    const body = h('div', { class: 'space-y-4' }, h('div', { class: 'h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800' }));
    const SCHEDULE = { off: 'вручную', daily: 'каждый день', weekly: 'по воскресеньям' };
    const selectCls = 'select w-full';

    async function load() {
      let data;
      try {
        data = await api.backups();
      } catch (err) {
        return body.replaceChildren(h('p', { class: 'text-sm text-rose-600' }, err.message));
      }
      const name = (id) => data.storages.find((s) => s.id === id)?.name ?? id;
      if (data.storages.length < 2) {
        return body.replaceChildren(h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' },
          'Нужно хотя бы два хранилища: копия делается в другое (лучше — у другого провайдера). Подключите второе в карточке «Хранилища».'));
      }
      const row = (p) => {
        const last = p.last;
        const lastText = !last ? 'ещё не запускалась'
          : last.status === 'done'
            ? (last.kind === 'restore'
              ? `восстановлено ${last.restored} (${formatSize(last.bytes)})${last.failed ? `, ошибок ${last.failed}` : ''}`
              : `скопировано ${last.copied} (${formatSize(last.bytes)}), без изменений ${last.skipped}${last.deleted ? `, удалено ${last.deleted}` : ''}${last.failed ? `, ошибок ${last.failed}` : ''}`)
            : `${last.status === 'cancelled' ? 'отменено' : 'ошибка'}: ${last.error ?? ''}`;
        const run = async (restore) => {
          if (restore && !(await confirmDialog('Восстановить из копии?', `В «${name(p.source)}» вернутся файлы, которых там нет, но есть в копии. Существующие файлы не меняются.`, 'Восстановить'))) return;
          try {
            const { job } = restore ? await api.restoreBackup(p.id) : await api.runBackup(p.id);
            ctx.trackJob(job, { kind: 'backup', label: job.name }).then(load);
            load();
          } catch (err) {
            toast(err.message, 'error');
          }
        };
        return h('li', { class: 'flex flex-wrap items-center gap-3 py-3' },
          h('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }, icon('server')),
          h('div', { class: 'min-w-0 flex-1' },
            h('p', { class: 'text-sm font-medium' }, `${name(p.source)} → ${name(p.target)}`),
            h('p', { class: 'text-xs text-slate-500 dark:text-slate-400' },
              [SCHEDULE[p.schedule] + (p.schedule !== 'off' ? ` в ${p.hour}:00` : ''), p.mirror ? 'зеркало (удалённое удаляется и из копии)' : 'удалённое остаётся в копии',
                p.running ? 'идёт сейчас' : last && `последний раз ${formatDateShort(last.at)}: ${lastText}`].filter(Boolean).join(' · '))),
          h('div', { class: 'flex gap-1' },
            h('button', { type: 'button', class: 'btn-ghost border border-slate-200 dark:border-slate-700', disabled: p.running, onclick: () => run(false) }, icon('refresh'), 'Копировать сейчас'),
            h('button', { type: 'button', class: 'btn-ghost', disabled: p.running, onclick: () => run(true) }, 'Восстановить…'),
            h('button', { type: 'button', class: 'icon-btn-danger', title: 'Удалить настройку', 'aria-label': 'Удалить настройку резервной копии',
              onclick: async () => {
                if (!(await confirmDialog('Удалить настройку?', 'Сама копия в хранилище останется — её можно удалить вручную (папка .backup).', 'Удалить'))) return;
                await api.deleteBackup(p.id).catch((err) => toast(err.message, 'error'));
                load();
              } }, icon('trash'))));
      };
      const options = (sel) => data.storages.map((s) => h('option', { value: s.id, selected: s.id === sel }, s.name));
      const source = h('select', { class: selectCls, 'aria-label': 'Что копировать' }, options(data.storages[0].id));
      const target = h('select', { class: selectCls, 'aria-label': 'Куда копировать' }, options(data.storages[1].id));
      const schedule = h('select', { class: selectCls, 'aria-label': 'Расписание' }, Object.entries(SCHEDULE).map(([v, l]) => h('option', { value: v, selected: v === 'daily' }, l)));
      const hour = h('select', { class: selectCls, 'aria-label': 'Час' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === 3 }, `${i}:00`)));
      const mirror = h('input', { type: 'checkbox', class: 'check', id: 'backup-mirror' });
      const status = statusLine();
      const add = h('button', { type: 'button', class: 'btn-primary', onclick: async () => {
        try {
          await api.createBackup({ source: source.value, target: target.value, schedule: schedule.value, hour: Number(hour.value), mirror: mirror.checked });
          load();
        } catch (err) {
          setStatus(status, 'error', err.message);
        }
      } }, icon('plus'), 'Добавить');
      body.replaceChildren(
        data.plans.length ? h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' }, data.plans.map(row)) : h('p', { class: 'text-sm text-slate-500' }, 'Резервных копий пока нет.'),
        h('div', { class: 'grid gap-3 rounded-xl border border-dashed border-slate-300 p-4 sm:grid-cols-4 dark:border-slate-700' },
          h('label', { class: 'text-sm' }, h('span', { class: 'mb-1 block font-medium' }, 'Что'), source),
          h('label', { class: 'text-sm' }, h('span', { class: 'mb-1 block font-medium' }, 'Куда'), target),
          h('label', { class: 'text-sm' }, h('span', { class: 'mb-1 block font-medium' }, 'Когда'), schedule),
          h('label', { class: 'text-sm' }, h('span', { class: 'mb-1 block font-medium' }, 'Во сколько'), hour),
          h('label', { for: 'backup-mirror', class: 'flex items-center gap-2 text-sm sm:col-span-3' }, mirror, 'Зеркало: удалённое в источнике удалять и из копии'),
          h('div', { class: 'flex justify-end' }, add),
          h('div', { class: 'sm:col-span-4' }, status)));
    }
    load();
    return card('Резервное копирование', 'Копия хранилища в другое: новые и изменённые файлы, по расписанию или вручную. Лежит в служебной папке .backup — на диске не видна.', 'server', body);
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
