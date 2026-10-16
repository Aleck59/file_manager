// «Поделиться»: публичная ссылка через сайт на файл или папку (/s/<id>).
import { api } from './api.js';
import { copyToClipboard, folderLabel, formatDate, h, icon, toast } from './ui.js';
import qrcode from './vendor/qrcode.js';

// Короткий адрес портала (files.example.com/a), если он задан, иначе /s/<id>.
export const shareUrl = (id, slug) => (slug ? `${location.origin}/${slug}` : `${location.origin}/s/${id}`);

function qrCanvas(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const scale = 6;
  const m = 3;
  const canvas = h('canvas', { width: (n + m * 2) * scale, height: (n + m * 2) * scale, class: 'h-36 w-36 rounded-lg [image-rendering:pixelated]', role: 'img', 'aria-label': 'QR-код ссылки' });
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#0f172a';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + m) * scale, (r + m) * scale, scale, scale);
  return canvas;
}

/**
 * @param {{ file?: {key: string, name: string}, folder?: string }} target
 */
export function openShareDialog(target) {
  const isFile = Boolean(target.file);
  const title = isFile ? target.file.name : folderLabel(target.folder);
  const radio = (name, value, label, hint, checked) => h('label', { class: 'flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/60 dark:border-slate-700 dark:has-[:checked]:bg-brand-950/40' },
    h('input', { type: 'radio', name, value, checked, class: 'check mt-0.5' }),
    h('span', {}, h('span', { class: 'block font-medium' }, label), hint && h('span', { class: 'block text-xs text-slate-500 dark:text-slate-400' }, hint)));
  const typeBox = !isFile && h('fieldset', { class: 'space-y-2' },
    h('legend', { class: 'mb-1.5 text-sm font-medium' }, 'Что можно по ссылке'),
    radio('share-type', 'folder', 'Смотреть и скачивать', 'Файлы и подпапки — только чтение', true),
    radio('share-type', 'upload', 'Загружать файлы мне', 'Гость ничего не видит, только отправляет файлы в эту папку', false),
    radio('share-type', 'request', 'Запросить файл', 'Одноразовая ссылка со сроком: гость отправляет файлы и нажимает «Готово»', false));
  const expiry = h('select', { id: 'share-exp', class: 'input' },
    [['1', '1 день'], ['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней'], ['', 'Бессрочно']].map(([v, l]) => h('option', { value: v, selected: v === '7' }, l)));
  const password = h('input', { id: 'share-pass', type: 'text', class: 'input', placeholder: 'без пароля', autocomplete: 'off', maxlength: 128 });
  const limit = h('input', { id: 'share-limit', type: 'number', class: 'input', min: 1, placeholder: 'без лимита', inputmode: 'numeric' });
  const limitLabel = h('label', { for: 'share-limit', class: 'mb-1.5 block text-sm font-medium' }, 'Лимит скачиваний');
  const maxSize = h('input', { id: 'share-maxsize', type: 'number', class: 'input', min: 1, placeholder: 'как в настройках', inputmode: 'numeric' });
  const maxSizeWrap = h('div', { class: 'hidden' }, h('label', { for: 'share-maxsize', class: 'mb-1.5 block text-sm font-medium' }, 'Макс. размер файла, МБ'), maxSize);
  // Портал загрузки: свой короткий адрес и подпись на странице.
  const slug = h('input', { id: 'share-slug', type: 'text', class: 'min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm outline-none', placeholder: 'a', autocomplete: 'off', spellcheck: 'false', maxlength: 40 });
  const caption = h('input', { id: 'share-caption', type: 'text', class: 'input', placeholder: 'Загрузить файлы', maxlength: 200 });
  const captionLabel = h('label', { for: 'share-caption', class: 'mb-1.5 block text-sm font-medium' }, 'Подпись на странице');
  const slugWrap = h('div', {});
  slugWrap.append(h('label', { for: 'share-slug', class: 'mb-1.5 block text-sm font-medium' }, 'Свой адрес'),
    h('div', { class: 'flex overflow-hidden rounded-xl border border-slate-300 bg-white focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-900' },
      h('span', { class: 'flex items-center border-r border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-800' }, `${location.host}/`), slug));
  const portalWrap = h('div', { class: 'hidden grid gap-4 sm:col-span-2 sm:grid-cols-2' },
    slugWrap,
    h('div', {}, captionLabel, caption));
  const error = h('p', { class: 'hidden rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn-primary' }, icon('link'), 'Создать ссылку');
  const form = h('form', { class: 'space-y-4 p-6' },
    h('h3', { class: 'text-lg font-semibold' }, 'Поделиться'),
    h('p', { class: 'break-words text-sm text-slate-500 dark:text-slate-400' }, title),
    typeBox,
    h('div', { class: 'grid gap-4 sm:grid-cols-2' },
      h('div', {}, h('label', { for: 'share-exp', class: 'mb-1.5 block text-sm font-medium' }, 'Срок действия'), expiry),
      h('div', {}, h('label', { for: 'share-pass', class: 'mb-1.5 block text-sm font-medium' }, 'Пароль'), password),
      h('div', {}, limitLabel, limit),
      maxSizeWrap,
      portalWrap),
    error,
    h('div', { class: 'flex justify-end gap-2' },
      h('button', { type: 'button', class: 'btn-ghost', onclick: () => dialog.close() }, 'Отмена'), submit));
  const dialog = h('dialog', { class: 'w-[min(34rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' }, form);
  const type = () => (isFile ? 'file' : form.querySelector('input[name=share-type]:checked').value);
  const forever = expiry.querySelector('option[value=""]');
  form.addEventListener('change', (e) => {
    const t = type();
    const upload = t === 'upload' || t === 'request';
    limitLabel.textContent = upload ? 'Лимит файлов' : 'Лимит скачиваний';
    maxSizeWrap.classList.toggle('hidden', !upload);
    portalWrap.classList.toggle('hidden', !upload);
    // Запрос — всегда со сроком (по нему и напоминание), без своего адреса.
    slugWrap.classList.toggle('hidden', t === 'request');
    captionLabel.textContent = t === 'request' ? 'Что прислать' : 'Подпись на странице';
    caption.placeholder = t === 'request' ? 'Например: скан паспорта' : 'Загрузить файлы';
    forever.hidden = t === 'request';
    if (e.target.name === 'share-type' && t === 'request') expiry.value = '7';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    error.classList.add('hidden');
    const choice = type();
    const t = choice === 'request' ? 'upload' : choice;
    try {
      const { share } = await api.createShare({
        type: t, request: choice === 'request', key: target.file?.key, folder: target.folder,
        expiresInDays: expiry.value ? Number(expiry.value) : null,
        password: password.value,
        maxDownloads: t !== 'upload' && limit.value ? Number(limit.value) : null,
        maxUploads: t === 'upload' && limit.value ? Number(limit.value) : null,
        maxFileSizeMb: t === 'upload' && maxSize.value ? Number(maxSize.value) : null,
        slug: choice === 'upload' ? slug.value.trim().toLowerCase() || null : null,
        caption: t === 'upload' ? caption.value.trim() || null : null,
      });
      showResult(share);
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    } finally {
      submit.disabled = false;
    }
  });

  function showResult(share) {
    const url = shareUrl(share.id, share.slug);
    const details = [share.expiresAt ? `до ${formatDate(share.expiresAt)}` : 'бессрочно',
      share.hasPassword && 'с паролем',
      share.maxDownloads && `${share.maxDownloads} скачиваний`, share.maxUploads && `${share.maxUploads} файлов`].filter(Boolean).join(' · ');
    const copy = async () => { await copyToClipboard(url); toast('Ссылка скопирована', 'success'); };
    form.replaceChildren(
      h('h3', { class: 'text-lg font-semibold' }, 'Ссылка готова'),
      h('div', { class: 'flex flex-col items-center gap-4 sm:flex-row sm:items-start' },
        qrCanvas(url),
        h('div', { class: 'min-w-0 flex-1 space-y-3' },
          h('div', { class: 'flex items-center gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-950' },
            h('code', { class: 'min-w-0 flex-1 truncate font-mono text-sm' }, url),
            h('button', { type: 'button', class: 'icon-btn shrink-0', title: 'Скопировать', 'aria-label': 'Скопировать ссылку', onclick: copy }, icon('copy'))),
          h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, details),
          share.hasPassword && h('p', { class: 'text-xs text-slate-500 dark:text-slate-400' }, 'Пароль сообщите отдельно — не в том же сообщении, что и ссылку.'),
          h('a', { href: '#/shares', class: 'link text-sm', onclick: () => dialog.close() }, 'Все мои ссылки'))),
      h('div', { class: 'flex justify-end gap-2' },
        h('button', { type: 'button', class: 'btn-ghost', onclick: copy }, icon('copy'), 'Скопировать'),
        h('button', { type: 'button', class: 'btn-primary', onclick: () => dialog.close() }, 'Готово')));
    copy().catch(() => {});
  }

  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  (form.querySelector('input[name=share-type]') ?? expiry).focus();
}
