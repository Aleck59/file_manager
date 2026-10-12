// Настройки администратора: все параметры .env, которые можно менять из интерфейса.
// Значения из .env остаются значениями по умолчанию; изменения хранятся на сервере
// в data/settings.json. Секреты в браузер не передаются — их можно только заменить.
import { api } from '../api.js';
import { detectPreset, S3_PRESETS } from '../s3-presets.js';
import { confirmDialog, FILES, formatSize, h, icon, openDialog, pluralize, toast } from '../ui.js';

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
    root.replaceChildren(storagesCard(), limitsCard(f), appCard(f), infoCard());
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
          el.textContent = x.error ? `недоступно: ${x.error}`
            : `${formatSize(x.size)}${x.quota ? ` из ${formatSize(x.quota)}` : ''} · ${pluralize(x.files, FILES)}${x.complete ? '' : '+'}`;
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
            st.quotaGb > 0 && h('span', { class: 'badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }, `квота ${st.quotaGb} ГБ`)),
          h('p', { class: 'truncate text-sm text-slate-500 dark:text-slate-400', title: `${st.endpoint} · ${st.bucket}/${st.prefix}` },
            `${detectPreset(st.endpoint)?.name ?? new URL(st.endpoint).host} · ${st.bucket}/${st.prefix}`),
          h('p', { class: 'mt-0.5 text-xs tabular-nums text-slate-500 dark:text-slate-400', dataset: { usage: st.id } }, ' '),
          status),
        h('div', { class: 'flex shrink-0 gap-0.5' },
          list.length > 1 && action('chevronRight', 'Выше', () => move(i, -1), `-rotate-90 ${i === 0 ? 'invisible' : ''}`),
          list.length > 1 && action('chevronRight', 'Ниже', () => move(i, 1), `rotate-90 ${i === list.length - 1 ? 'invisible' : ''}`),
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
    const v = st ?? { name: '', endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', forcePathStyle: true, prefix: 'uploads/', quotaGb: 0, acceptUploads: true, hasSecret: false };
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
      prefix: input('prefix', 'Папка в бакете', { hint: 'Например uploads/. Пусто — корень бакета.' }),
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
    const preset = h('select', { id: 'st-preset', class: 'input', onchange: () => {
      const p = S3_PRESETS.find((x) => x.id === preset.value);
      showHint(p);
      if (!p) return;
      f.endpoint.el.value = p.endpoint;
      f.region.el.value = p.region;
      f.forcePathStyle.el.checked = p.pathStyle;
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
