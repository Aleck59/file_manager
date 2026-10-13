// Модальное окно выбора папки (для перемещения файлов): своё дерево с ленивой подгрузкой.
import { api } from './api.js';
import { folderLabel, h, icon } from './ui.js';

/**
 * @param {{ title: string, current: string, confirmLabel?: string, allowCurrent?: boolean }} opts
 *   current — папка, в которой файл лежит сейчас (её выбрать нельзя, если не allowCurrent —
 *   например, при копировании: копия в той же папке получает имя «… (копия)»).
 * @returns {Promise<string|null>} путь выбранной папки или null при отмене
 */
export function pickFolder({ title, current, confirmLabel = 'Переместить', allowCurrent = false }) {
  return new Promise((resolve) => {
    const nodes = new Map(); // path -> { children, expanded }
    const node = (p) => nodes.get(p) ?? nodes.set(p, { children: null, expanded: false }).get(p);
    let selected = null;
    let result = null;

    const list = h('div', { class: 'max-h-[50vh] min-h-[12rem] overflow-y-auto rounded-xl border border-slate-200 p-1.5 text-sm dark:border-slate-700', role: 'tree' });
    const hint = h('p', { class: 'min-h-[1.25rem] truncate text-xs text-slate-500 dark:text-slate-400' });
    const confirm = h('button', { type: 'button', class: 'btn-primary', disabled: true, onclick: () => { result = selected; dialog.close(); } }, confirmLabel);
    const dialog = h('dialog', { class: 'w-[min(30rem,calc(100%-2rem))] rounded-2xl bg-white p-0 text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-200' },
      h('div', { class: 'space-y-4 p-6' },
        h('h3', { class: 'text-lg font-semibold' }, title),
        list,
        hint,
        h('div', { class: 'flex justify-end gap-2' },
          h('button', { type: 'button', class: 'btn-ghost', onclick: () => dialog.close() }, 'Отмена'),
          confirm)));

    async function expand(path) {
      const n = node(path);
      n.expanded = !n.expanded;
      if (n.expanded && !n.children) {
        render();
        try {
          n.children = (await api.listFolder(path)).folders;
        } catch (err) {
          n.children = [];
          hint.textContent = err.message;
        }
      }
      render();
    }

    function select(path) {
      if (path === current && !allowCurrent) return;
      selected = path;
      confirm.disabled = false;
      hint.textContent = `${confirmLabel.replace(/ сюда$/, '')} в: ${folderLabel(path)}`;
      render();
    }

    function row(path, name, depth) {
      const n = node(path);
      const isCurrent = path === current && !allowCurrent;
      const isSelected = path === selected;
      const hasKids = n.children === null || n.children.length > 0;
      const el = h('div', {
        class: `flex h-9 items-center gap-1 rounded-lg pr-2 transition ${isSelected
          ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'
          : isCurrent ? 'cursor-not-allowed text-slate-400' : 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800'}`,
        role: 'treeitem', tabindex: '0', dataset: { path },
        'aria-selected': String(isSelected), 'aria-disabled': isCurrent ? 'true' : undefined,
        title: isCurrent ? 'Файл уже в этой папке' : name,
        onclick: () => select(path),
        ondblclick: () => hasKids && expand(path),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(path); }
          if (e.key === 'ArrowRight' && !n.expanded) expand(path);
          if (e.key === 'ArrowLeft' && n.expanded) expand(path);
        },
      },
      h('button', {
        type: 'button', tabindex: '-1',
        class: `flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 ${hasKids ? '' : 'invisible'}`,
        'aria-label': n.expanded ? 'Свернуть' : 'Развернуть',
        onclick: (e) => { e.stopPropagation(); expand(path); },
      }, icon('chevronRight', `h-3.5 w-3.5 transition-transform ${n.expanded ? 'rotate-90' : ''}`)),
      icon(path === '' ? 'drive' : 'folder', 'h-4 w-4'),
      h('span', { class: 'ml-1.5 truncate' }, name),
      isCurrent && h('span', { class: 'ml-auto shrink-0 text-xs' }, 'сейчас здесь'));
      el.style.paddingLeft = `${depth * 16 + 2}px`;

      const out = [el];
      if (n.expanded) {
        if (n.children === null) {
          const loading = h('div', { class: 'py-1.5 text-xs text-slate-400' }, 'Загрузка…');
          loading.style.paddingLeft = `${(depth + 1) * 16 + 32}px`;
          out.push(loading);
        } else {
          for (const c of n.children) out.push(...row(c.path, c.name, depth + 1));
        }
      }
      return out;
    }

    function render() {
      const focusedPath = list.contains(document.activeElement) ? document.activeElement.dataset.path : null;
      list.replaceChildren(...row('', 'Мой диск', 0));
      for (const el of list.querySelectorAll('[role=treeitem]')) {
        if (focusedPath !== null && el.dataset.path === focusedPath) el.focus();
      }
    }

    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    // Сразу раскрываем путь до текущей папки, чтобы было видно соседние.
    (async () => {
      const chain = [''];
      for (let i = current.indexOf('/'); i !== -1; i = current.indexOf('/', i + 1)) chain.push(current.slice(0, i + 1));
      for (const p of chain) {
        if (!node(p).expanded) await expand(p);
      }
      list.querySelector('[role=treeitem]')?.focus();
    })();
  });
}
