// «Входящие»: файлы и ссылки, отправленные в приложение через «Поделиться» (PWA, Android).
// Service worker (sw.js) кладёт их во временный кеш; здесь выбирается папка и запускается загрузка.
import { pickFolder } from '../folder-picker.js';
import { fileBadge, folderLabel, formatSize, h, icon, toast } from '../ui.js';

const INBOX = 'fm-share-inbox';

export async function inboxItems() {
  if (!('caches' in window)) return [];
  const cache = await caches.open(INBOX);
  const items = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (!res) continue;
    const kind = res.headers.get('X-Kind') === 'text' ? 'text' : 'file';
    items.push({ req, res, kind, name: decodeURIComponent(res.headers.get('X-Name') ?? ''), type: res.headers.get('Content-Type') ?? '' });
  }
  return items;
}

export function mountInbox(view, ctx) {
  ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Входящие'), []);
  let target = ctx.personal?.path ?? '';
  const body = h('div', { class: 'space-y-4' }, h('div', { class: 'card h-32 animate-pulse' }));
  view.replaceChildren(h('div', { class: 'mx-auto max-w-3xl space-y-4 p-4 sm:p-6' },
    h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, 'Файлы, отправленные сюда через «Поделиться» на телефоне. Выберите папку — и они загрузятся.'),
    body));

  async function render() {
    const items = await inboxItems();
    if (!items.length) {
      body.replaceChildren(h('div', { class: 'card flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400' },
        icon('upload', 'h-8 w-8 text-slate-300 dark:text-slate-600'), 'Входящих нет',
        h('p', { class: 'max-w-sm text-xs' }, 'Установите файлообменник как приложение (меню браузера → «Установить приложение»), и он появится в списке «Поделиться».')));
      return;
    }
    const files = await Promise.all(items.filter((i) => i.kind === 'file').map(async (i) => ({ ...i, blob: await i.res.blob() })));
    const texts = await Promise.all(items.filter((i) => i.kind === 'text').map(async (i) => ({ ...i, text: await i.res.text() })));
    const where = h('span', { class: 'font-medium' }, folderLabel(target));
    const upload = h('button', { type: 'button', class: 'btn-primary', disabled: !files.length || !ctx.can('editor') }, icon('upload'), `Загрузить (${files.length})`);
    const change = h('button', { type: 'button', class: 'btn-ghost', onclick: async () => {
      const picked = await pickFolder({ title: 'Куда загрузить', current: target, confirmLabel: 'Выбрать', allowCurrent: true });
      if (picked !== null) { target = picked; where.textContent = folderLabel(target); }
    } }, 'Изменить');
    upload.addEventListener('click', async () => {
      const list = files.map((f) => new File([f.blob], f.name || 'файл', { type: f.type }));
      ctx.enqueueFiles(list, target);
      const cache = await caches.open(INBOX);
      for (const f of files) await cache.delete(f.req);
      toast(`Загружается: ${list.length}`, 'success');
      render();
    });
    const urlOf = (t) => t.match(/https?:\/\/\S+/)?.[0];
    body.replaceChildren(
      files.length ? h('section', { class: 'card overflow-hidden' },
        h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800' }, files.map((f) => h('li', { class: 'flex items-center gap-3 px-4 py-3' },
          fileBadge(f.name),
          h('span', { class: 'min-w-0 flex-1 truncate text-sm font-medium' }, f.name),
          h('span', { class: 'shrink-0 text-xs tabular-nums text-slate-500' }, formatSize(f.blob.size))))),
        h('div', { class: 'flex flex-wrap items-center gap-2 border-t border-slate-200 p-4 dark:border-slate-800' },
          h('p', { class: 'min-w-0 flex-1 text-sm' }, 'В папку: ', where), change, upload)) : null,
      ...texts.map((t) => h('section', { class: 'card space-y-3 p-4' },
        h('p', { class: 'whitespace-pre-wrap break-words text-sm' }, t.text),
        h('div', { class: 'flex flex-wrap gap-2' },
          urlOf(t.text) && ctx.can('editor') && h('button', { type: 'button', class: 'btn-primary', onclick: async () => {
            await ctx.importFromUrl(target, urlOf(t.text));
            await (await caches.open(INBOX)).delete(t.req);
            render();
          } }, icon('globe'), 'Скачать по ссылке на диск'),
          h('button', { type: 'button', class: 'btn-ghost', onclick: async () => { await (await caches.open(INBOX)).delete(t.req); render(); } }, 'Убрать')))),
      files.length ? h('button', { type: 'button', class: 'btn-ghost text-rose-600', onclick: async () => {
        const cache = await caches.open(INBOX);
        for (const f of files) await cache.delete(f.req);
        render();
      } }, 'Очистить входящие') : null,
    );
  }
  render().catch((err) => toast(err.message, 'error'));
  return { unmount() {} };
}
