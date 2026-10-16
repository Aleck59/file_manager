// Дерево папок в левой панели. Подпапки подгружаются лениво при раскрытии;
// при переходе в глубокую папку автоматически раскрываются все её предки.
import { api } from './api.js';
import { h, homeFolder, icon, makeDropTarget, toast } from './ui.js';

const nodes = new Map(); // path -> { children: [{path,name}] | null, expanded, loading }
let container;
let activePath = null;
let onNavigate = () => {};
let dropHandler = null; // (key, folderPath) => void — перетаскивание файла на папку дерева
let menuHandler = null; // ({path, name}, anchor) => void — контекстное меню папки

const node = (path) => {
  if (!nodes.has(path)) nodes.set(path, { children: null, expanded: false, loading: null });
  return nodes.get(path);
};

const parentOf = (path) => path.slice(0, path.slice(0, -1).lastIndexOf('/') + 1);

async function loadChildren(path) {
  const n = node(path);
  n.loading ??= api.listFolder(path)
    .then((res) => { n.children = res.folders; })
    .catch((err) => { toast(err.message, 'error'); n.children ??= []; })
    .finally(() => { n.loading = null; });
  return n.loading;
}

// Дисковый вид уже знает подпапки текущей папки — передаёт их, чтобы не делать лишний запрос.
export function setChildren(path, folders) {
  node(path).children = folders;
  render();
}

export async function reload(path) {
  node(path).children = null;
  if (path === '') path = homeFolder;
  if (node(path).expanded || path === homeFolder) await loadChildren(path);
  render();
}

export function forget(path) {
  for (const key of [...nodes.keys()]) if (key.startsWith(path)) nodes.delete(key);
}

export async function reveal(path) {
  activePath = path;
  // Цепочка от корня диска пользователя (личной папки или всего диска) до папки.
  const chain = [homeFolder];
  if (path.startsWith(homeFolder)) {
    for (let i = path.indexOf('/', homeFolder.length); i !== -1; i = path.indexOf('/', i + 1)) chain.push(path.slice(0, i + 1));
  }
  // Раскрываем папку и всех её предков, чтобы были видны соседи и подпапки.
  for (const p of chain) {
    node(p).expanded = true;
    if (!node(p).children) await loadChildren(p);
  }
  node(homeFolder).expanded = true;
  render();
}

export function clearActive() {
  activePath = null;
  render();
}

async function toggle(path) {
  const n = node(path);
  n.expanded = !n.expanded;
  if (n.expanded && !n.children) {
    render();
    await loadChildren(path);
  }
  render();
}

function renderNode(path, name, depth) {
  const n = node(path);
  const hasKids = n.children === null || n.children.length > 0;
  const chevron = h('button', {
    type: 'button',
    class: `flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 ${hasKids ? '' : 'invisible'}`,
    'aria-label': n.expanded ? 'Свернуть' : 'Развернуть',
    onclick: (e) => { e.stopPropagation(); toggle(path); },
  }, icon('chevronRight', `h-3.5 w-3.5 transition-transform ${n.expanded ? 'rotate-90' : ''}`));

  const row = h('div', {
    class: 'tree-row cursor-pointer',
    role: 'treeitem',
    'aria-expanded': hasKids ? String(n.expanded) : undefined,
    'aria-current': path === activePath ? 'true' : 'false',
    tabindex: '0',
    title: name,
    onclick: () => onNavigate(path),
    oncontextmenu: (e) => {
      if (path === homeFolder) return; // корень: системное меню
      e.preventDefault();
      const at = {
        getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }),
        setAttribute() {}, focus() {},
      };
      if (menuHandler) menuHandler({ path, name }, at);
      else onNavigate(path); // не на странице диска — просто открыть папку
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') onNavigate(path);
      if (e.key === 'ArrowRight' && !n.expanded) toggle(path);
      if (e.key === 'ArrowLeft' && n.expanded) toggle(path);
    },
  },
  chevron,
  icon(path === homeFolder ? 'drive' : 'folder', `h-4 w-4 ${path === activePath ? '' : 'text-slate-400'}`),
  h('span', { class: 'ml-1.5 truncate' }, name));
  // Отступ уровня через CSSOM (inline style-атрибуты запрещены CSP).
  row.style.paddingLeft = `${depth * 14 + 2}px`;
  if (dropHandler) makeDropTarget(row, (key) => dropHandler(key, path));

  const items = [row];
  if (n.expanded) {
    if (n.children === null) {
      const loading = h('div', { class: 'py-1 text-xs text-slate-400' }, 'Загрузка…');
      loading.style.paddingLeft = `${(depth + 1) * 14 + 30}px`;
      items.push(loading);
    } else {
      const group = h('div', { role: 'group' });
      for (const child of n.children) group.append(...renderNode(child.path, child.name, depth + 1));
      items.push(group);
    }
  }
  return items;
}

export function render() {
  if (!container) return;
  container.replaceChildren(...renderNode(homeFolder, 'Мой диск', 0));
}

export function setMenuHandler(fn) {
  menuHandler = fn;
}

export function setDropHandler(fn) {
  dropHandler = fn;
  render();
}

export function initTree(el, navigate, { load = true } = {}) {
  container = el;
  onNavigate = navigate;
  node(homeFolder).expanded = true;
  if (load) loadChildren(homeFolder).then(render);
  else node(homeFolder).children = [];
  render();
}

export { parentOf };

/** Все папки, о которых дерево уже знает (для командной палитры): [{path, name}]. */
export function knownFolders() {
  const out = new Map();
  for (const n of nodes.values()) for (const child of n.children ?? []) out.set(child.path, child);
  return [...out.values()];
}
