// Предпросмотр содержимого архива (ZIP) и документов Office (docx, xlsx, pptx).
// Сервер отдаёт структуру (оглавление архива, абзацы, листы, слайды) — DOM строится здесь
// из текста, без innerHTML: разметка из документа на страницу не попадает.
import { api } from './api.js';
import { formatDateShort, formatSize, h, icon } from './ui.js';

const frame = 'max-h-[28rem] overflow-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950';

function loadingBox() {
  return h('div', { class: 'aspect-[4/3] w-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800' });
}
function errorBox(text) {
  return h('div', { class: 'rounded-xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400' }, text);
}

/** Кнопка «На весь экран»: тот же вид в большом окне. */
function expandable(title, build) {
  const btn = h('button', { type: 'button', class: 'icon-btn h-8 w-8', title: 'На весь экран', 'aria-label': `Открыть «${title}» на весь экран` }, icon('expand'));
  btn.addEventListener('click', () => {
    const dialog = h('dialog', { class: 'h-[min(48rem,calc(100%-2rem))] w-[min(64rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200', 'aria-label': title },
      h('div', { class: 'flex h-full flex-col' },
        h('div', { class: 'flex items-center gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800' },
          h('h3', { class: 'min-w-0 flex-1 truncate font-semibold' }, title),
          h('button', { type: 'button', class: 'icon-btn h-8 w-8', 'aria-label': 'Закрыть', onclick: () => dialog.close() }, icon('close'))),
        h('div', { class: 'min-h-0 flex-1 overflow-auto p-5' }, build(true))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  });
  return btn;
}

// ---------- ZIP ----------
export function zipBlock(file) {
  const wrap = h('div', { class: 'space-y-2' }, loadingBox());
  (async () => {
    let data;
    try {
      data = await api.zipList(file.key);
    } catch (err) {
      return wrap.replaceChildren(errorBox(err.message));
    }
    const files = data.entries.filter((e) => !e.dir);
    const dirs = new Set();
    for (const e of data.entries) {
      const parts = e.name.split('/').filter(Boolean);
      for (let i = 1; i < parts.length + (e.dir ? 1 : 0); i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const unpacked = files.reduce((a, e) => a + e.size, 0);
    const summary = `${files.length} ${files.length === 1 ? 'файл' : 'файлов'}${dirs.size ? `, папок: ${dirs.size}` : ''} · распаковано ${formatSize(unpacked)}${data.truncated ? ` · показаны первые ${data.entries.length} из ${data.total}` : ''}`;
    const build = (big) => {
      const filter = h('input', { type: 'search', class: 'input py-1.5 text-sm', placeholder: 'Найти в архиве', 'aria-label': 'Найти в архиве' });
      const list = h('ul', { class: `${big ? '' : frame} divide-y divide-slate-100 text-sm dark:divide-slate-800` });
      const render = () => {
        const q = filter.value.trim().toLowerCase();
        const shown = files.filter((e) => !q || e.name.toLowerCase().includes(q)).slice(0, 1000);
        list.replaceChildren(...shown.map((e) => {
          const slash = e.name.lastIndexOf('/');
          const name = e.name.slice(slash + 1);
          const dir = slash > 0 ? e.name.slice(0, slash + 1) : '';
          const href = `/api/files/zip/entry?key=${encodeURIComponent(file.key)}&i=${e.i}`;
          return h('li', { class: 'flex items-center gap-2 px-3 py-2' },
            h('div', { class: 'min-w-0 flex-1' },
              h('p', { class: 'truncate', title: e.name }, dir && h('span', { class: 'text-slate-400' }, dir), name),
              h('p', { class: 'text-xs tabular-nums text-slate-500 dark:text-slate-400' },
                [formatSize(e.size), e.modified && formatDateShort(e.modified), e.encrypted && 'с паролем'].filter(Boolean).join(' · '))),
            e.encrypted || (e.method !== 0 && e.method !== 8)
              ? h('span', { class: 'shrink-0 text-xs text-slate-400', title: 'Этот файл не распаковать на сервере' }, '—')
              : h('a', { href, download: name, class: 'icon-btn h-8 w-8 shrink-0', title: 'Скачать этот файл', 'aria-label': `Скачать «${name}» из архива` }, icon('download')));
        }));
        if (!shown.length) list.replaceChildren(h('li', { class: 'px-3 py-6 text-center text-slate-500' }, q ? 'Ничего не найдено' : 'Архив пуст'));
      };
      filter.addEventListener('input', render);
      render();
      return h('div', { class: 'space-y-2' }, files.length > 12 && filter, list);
    };
    wrap.replaceChildren(
      h('div', { class: 'flex items-center justify-between gap-2' },
        h('p', { class: 'text-xs text-slate-500 dark:text-slate-400' }, summary),
        expandable(file.name, build)),
      build(false));
  })();
  return wrap;
}

// ---------- Office ----------
function runs(list) {
  return list.map((r) => {
    let node = document.createTextNode(r.t);
    if (r.b) node = h('strong', {}, node);
    if (r.i) node = h('em', {}, node);
    if (r.u) node = h('u', {}, node);
    if (r.s) node = h('s', {}, node);
    return node;
  });
}

function table(rows, { header = true, numbers = false } = {}) {
  const width = Math.max(0, ...rows.map((r) => r?.length ?? 0));
  const letter = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const cellCls = 'border border-slate-200 px-2 py-1 align-top whitespace-pre-wrap dark:border-slate-700';
  const headCls = 'border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400';
  const body = [];
  if (numbers) body.push(h('tr', {}, h('th', { class: headCls }), ...Array.from({ length: width }, (_, i) => h('th', { class: headCls, scope: 'col' }, letter(i)))));
  rows.forEach((r, ri) => {
    const cells = Array.from({ length: width }, (_, i) => r?.[i] ?? '');
    const tag = header && !numbers && ri === 0 ? 'th' : 'td';
    body.push(h('tr', {},
      numbers && h('th', { class: headCls, scope: 'row' }, String(ri + 1)),
      ...cells.map((c) => h(tag, { class: `${cellCls} ${tag === 'th' ? 'bg-slate-50 font-semibold dark:bg-slate-900' : ''} ${/^-?\d+([.,]\d+)?$/.test(c) ? 'text-right tabular-nums' : ''}` }, c))));
  });
  return h('table', { class: 'w-max min-w-full border-collapse text-sm' }, h('tbody', {}, body));
}

function docxView(data) {
  const out = [];
  let list = null;
  for (const b of data.blocks) {
    if (b.type === 'li') {
      if (!list) { list = h('ul', { class: 'list-disc space-y-1 pl-6' }); out.push(list); }
      list.append(h('li', {}, runs(b.runs)));
      continue;
    }
    list = null;
    if (b.type === 'h') {
      const size = ['text-xl', 'text-lg', 'text-base', 'text-base', 'text-sm', 'text-sm'][b.level - 1];
      out.push(h(`h${Math.min(6, b.level + 2)}`, { class: `${size} font-semibold leading-snug` }, runs(b.runs)));
    } else if (b.type === 'table') {
      out.push(h('div', { class: 'overflow-x-auto' }, table(b.rows)));
    } else if (b.runs.length) {
      out.push(h('p', { class: 'whitespace-pre-wrap' }, runs(b.runs)));
    }
  }
  if (!out.length) out.push(h('p', { class: 'text-slate-500' }, 'В документе нет текста'));
  if (data.truncated) out.push(h('p', { class: 'text-xs text-slate-500' }, 'Документ длинный — показано начало. Полностью — скачайте файл.'));
  return h('div', { class: 'space-y-3 text-sm leading-relaxed' }, out);
}

function xlsxView(data) {
  if (!data.sheets.length) return h('p', { class: 'text-sm text-slate-500' }, 'В книге нет листов');
  const content = h('div', { class: 'overflow-auto' });
  const tabs = h('div', { class: 'flex gap-1 overflow-x-auto pb-1', role: 'tablist' });
  const show = (i) => {
    const s = data.sheets[i];
    for (const [j, t] of [...tabs.children].entries()) {
      t.setAttribute('aria-selected', String(j === i));
      t.setAttribute('aria-pressed', String(j === i));
    }
    content.replaceChildren(...[s.rows.length ? table(s.rows, { numbers: true }) : h('p', { class: 'p-3 text-sm text-slate-500' }, 'Лист пуст'),
      s.truncated && h('p', { class: 'p-2 text-xs text-slate-500' }, 'Показаны первые 500 строк и 50 столбцов')].filter(Boolean));
  };
  // Вкладки листов выглядят как чипы меток (выбранная — aria-pressed).
  data.sheets.forEach((s, i) => tabs.append(h('button', { type: 'button', role: 'tab', class: 'label-chip shrink-0', onclick: () => show(i) }, s.name)));
  show(0);
  return h('div', { class: 'space-y-2' }, data.sheets.length > 1 && tabs, content,
    data.moreSheets ? h('p', { class: 'text-xs text-slate-500' }, `Ещё листов: ${data.moreSheets} — скачайте файл`) : null);
}

function pptxView(data) {
  if (!data.slides.length) return h('p', { class: 'text-sm text-slate-500' }, 'В презентации нет слайдов');
  return h('ol', { class: 'space-y-3' }, data.slides.map((s, i) => h('li', { class: 'rounded-xl border border-slate-200 p-3 dark:border-slate-700' },
    h('p', { class: 'text-xs font-medium uppercase tracking-wide text-slate-400' }, `Слайд ${i + 1}`),
    s.title && h('p', { class: 'mt-1 font-semibold' }, s.title),
    s.text.length ? h('ul', { class: 'mt-1 list-disc space-y-0.5 pl-5 text-sm' }, s.text.map((t) => h('li', { class: 'whitespace-pre-wrap' }, t))) : null)),
  data.moreSlides ? h('li', { class: 'text-xs text-slate-500' }, `Ещё слайдов: ${data.moreSlides}`) : null);
}

export function officeBlock(file) {
  const wrap = h('div', { class: 'space-y-2' }, loadingBox());
  (async () => {
    let data;
    try {
      data = await api.office(file.key);
    } catch (err) {
      return wrap.replaceChildren(errorBox(err.message));
    }
    const view = { docx: docxView, xlsx: xlsxView, pptx: pptxView }[data.kind];
    const label = { docx: 'Документ Word', xlsx: 'Таблица Excel', pptx: 'Презентация PowerPoint' }[data.kind];
    const build = (big) => h('div', { class: big ? '' : `${frame} p-4` }, view(data));
    wrap.replaceChildren(
      h('div', { class: 'flex items-center justify-between gap-2' },
        h('p', { class: 'text-xs text-slate-500 dark:text-slate-400' }, `${label} · упрощённый вид, без картинок и оформления`),
        expandable(file.name, build)),
      build(false));
  })();
  return wrap;
}
