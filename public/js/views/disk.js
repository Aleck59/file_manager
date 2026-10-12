// Раздел «Диск»: содержимое папки, хлебные крошки, загрузка (drag-and-drop),
// переименование, перемещение (меню, окно выбора папки, перетаскивание на папку) и удаление.
import { api } from '../api.js';
import { closePreview, copyFileLink, isPreviewing, setPreviewEnabled, showPreview } from '../preview.js';
import { pickFolder } from '../folder-picker.js';
import * as tree from '../tree.js';
import {
  confirmDialog, DRAG_TYPE, FILES, fileBadge, folderLabel, FOLDERS, formatDate, formatSize, h, icon, makeDropTarget,
  openDialog, openMenu, pluralize, toast,
} from '../ui.js';

export const diskHash = (folder) => `#/disk/${folder.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${folder ? '/' : ''}`;

export function storageNotice(ctx) {
  return h('div', { class: 'mx-auto max-w-xl px-6 py-20 text-center' },
    h('span', { class: 'mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400' }, icon('server', 'h-6 w-6')),
    h('p', { class: 'text-lg font-semibold' }, 'Хранилище не настроено'),
    h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' },
      ctx.can('admin') ? 'Укажите параметры S3-хранилища — после этого здесь появятся файлы.' : 'Администратор ещё не подключил хранилище файлов.'),
    ctx.can('admin') && h('a', { href: '#/settings', class: 'btn-primary mt-6' }, icon('settings'), 'Открыть настройки'));
}

export function mountDisk(view, ctx, folder, { selectKey } = {}) {
  if (!ctx.storageConfigured) {
    ctx.setHeader(h('h1', { class: 'truncate text-base font-semibold' }, 'Мой диск'), []);
    view.replaceChildren(storageNotice(ctx));
    return { unmount() {} };
  }
  const canEdit = ctx.can('editor');
  const state = { folders: [], files: [], cursor: null, loading: false, selected: selectKey ?? null, query: '' };
  const cleanup = [];

  setPreviewEnabled(true);
  if (canEdit) tree.setDropHandler((key, path) => moveByKey(key, path));
  tree.reveal(folder);
  ctx.onPreviewClosed = () => { state.selected = null; markSelected(); };
  ctx.onPreviewMissing = () => load();

  // ---------- заголовок: хлебные крошки + действия ----------
  const crumbs = [['Мой диск', '']];
  let acc = '';
  for (const seg of folder.split('/').filter(Boolean)) { acc += `${seg}/`; crumbs.push([seg, acc]); }
  const breadcrumb = h('nav', { 'aria-label': 'Путь', class: 'flex min-w-0 items-center gap-1 text-sm' },
    crumbs.flatMap(([label, path], i) => {
      const last = i === crumbs.length - 1;
      const item = last
        ? h('span', { class: 'truncate font-semibold text-slate-900 dark:text-white', 'aria-current': 'page' }, label)
        : h('a', { href: diskHash(path), class: 'shrink-0 truncate rounded px-1 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white max-w-[10rem]' }, label);
      // Файл можно перетащить на родительскую папку в хлебных крошках.
      if (!last && canEdit) makeDropTarget(item, (key) => moveByKey(key, path));
      return i === 0 ? [item] : [icon('chevronRight', 'h-3.5 w-3.5 text-slate-300 dark:text-slate-600'), item];
    }));
  // На узких экранах показываем только последнюю пару крошек.
  if (crumbs.length > 2) breadcrumb.firstElementChild.classList.add('hidden', 'sm:block');

  ctx.setHeader(breadcrumb, canEdit ? [
    h('button', { type: 'button', class: 'btn-ghost', onclick: newFolder, title: 'Новая папка' }, icon('folderPlus'), h('span', { class: 'hidden md:inline' }, 'Папка')),
    h('button', { type: 'button', class: 'btn-primary', onclick: () => ctx.pickFiles(folder) }, icon('upload'), h('span', { class: 'hidden sm:inline' }, 'Загрузить')),
  ] : []);

  // ---------- разметка ----------
  const search = h('input', { type: 'search', placeholder: 'Поиск в папке', 'aria-label': 'Поиск в папке', class: 'input py-1.5 pl-9', oninput: (e) => { state.query = e.target.value.trim().toLowerCase(); renderList(); } });
  const summary = h('p', { class: 'text-sm text-slate-500 dark:text-slate-400' }, 'Загрузка…');
  const list = h('ul', { class: 'divide-y divide-slate-100 dark:divide-slate-800', role: 'listbox', 'aria-label': 'Содержимое папки' });
  const empty = h('div', { class: 'hidden px-6 py-16 text-center' });
  const skeleton = h('div', { class: 'space-y-3 p-4', 'aria-hidden': 'true' },
    [1, 2, 3, 4].map(() => h('div', { class: 'h-10 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800' })));
  const loadMore = h('button', { type: 'button', class: 'btn-ghost', onclick: () => load({ append: true }) }, 'Показать ещё');
  const loadMoreWrap = h('div', { class: 'hidden border-t border-slate-200 p-3 text-center dark:border-slate-800' }, loadMore);

  const dropzone = canEdit && h('button', {
    type: 'button',
    class: 'group flex w-full items-center gap-4 rounded-2xl border-2 border-dashed border-slate-300 bg-white px-5 py-4 text-left transition hover:border-brand-400 hover:bg-brand-50/50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-brand-600 dark:hover:bg-brand-950/30',
    onclick: () => ctx.pickFiles(folder),
  },
  h('span', { class: 'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 transition group-hover:scale-105 dark:bg-brand-950 dark:text-brand-400' }, icon('upload', 'h-5 w-5')),
  h('span', { class: 'min-w-0' },
    h('span', { class: 'block text-sm font-medium' }, 'Перетащите файлы сюда или ', h('span', { class: 'text-brand-600 dark:text-brand-400' }, 'выберите на компьютере')),
    h('span', { class: 'block text-xs text-slate-500 dark:text-slate-400' }, 'Файлы загружаются напрямую в хранилище S3, в текущую папку')));

  const overlay = h('div', { class: 'pointer-events-none absolute inset-3 z-10 hidden items-center justify-center rounded-2xl border-2 border-dashed border-brand-500 bg-brand-50/90 dark:bg-brand-950/80' },
    h('div', { class: 'text-center' },
      h('span', { class: 'mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-brand-600 shadow dark:bg-slate-900' }, icon('upload', 'h-7 w-7')),
      h('p', { class: 'font-medium text-brand-800 dark:text-brand-200' }, 'Отпустите, чтобы загрузить'),
      h('p', { class: 'text-sm text-brand-700/80 dark:text-brand-300/80' }, `в «${crumbs.at(-1)[0]}»`)));

  view.replaceChildren(
    h('div', { class: 'mx-auto max-w-6xl space-y-4 p-4 sm:p-6' },
      dropzone,
      h('section', { class: 'card overflow-hidden' },
        h('div', { class: 'flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800' },
          summary,
          h('div', { class: 'flex items-center gap-2' },
            h('div', { class: 'relative w-full sm:w-56' },
              h('span', { class: 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400' }, icon('search')),
              search),
            h('button', { type: 'button', class: 'icon-btn', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, icon('refresh')))),
        h('div', { class: 'hidden grid-cols-[minmax(0,1fr)_6.5rem_10.5rem_7.5rem] gap-4 border-b border-slate-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-400 md:grid dark:border-slate-800' },
          h('span', {}, 'Имя'), h('span', { class: 'text-right' }, 'Размер'), h('span', {}, 'Изменён'), h('span', { class: 'text-right' }, 'Действия')),
        list, empty, skeleton, loadMoreWrap)),
    overlay,
  );

  // ---------- строки ----------
  const rowClass = 'file-row grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 transition hover:bg-slate-50 md:grid-cols-[minmax(0,1fr)_6.5rem_10.5rem_7.5rem] dark:hover:bg-slate-800/40';
  const actionBtn = (name, label, onclick, danger) => h('button', {
    type: 'button', class: danger ? 'icon-btn-danger' : 'icon-btn', title: label, 'aria-label': label,
    onclick: (e) => { e.stopPropagation(); onclick(e.currentTarget); },
  }, icon(name));

  function folderRow(f) {
    const li = h('li', {
      class: rowClass, role: 'option', 'aria-selected': 'false', tabindex: '0',
      onclick: () => ctx.navigate(diskHash(f.path)),
      onkeydown: (e) => { if (e.key === 'Enter') ctx.navigate(diskHash(f.path)); },
    },
    h('div', { class: 'flex min-w-0 items-center gap-3' },
      h('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400' }, icon('folder')),
      h('div', { class: 'min-w-0' },
        h('p', { class: 'truncate text-sm font-medium', title: f.name }, f.name),
        h('p', { class: 'text-xs text-slate-500 md:hidden dark:text-slate-400' }, 'Папка'))),
    h('span', { class: 'hidden text-right text-sm text-slate-400 md:block' }, '—'),
    h('span', { class: 'hidden text-sm text-slate-500 md:block dark:text-slate-400' }, 'Папка'),
    h('div', { class: 'flex justify-end gap-0.5' },
      canEdit && actionBtn('trash', 'Удалить папку', () => deleteFolder(f), true)));
    if (canEdit) makeDropTarget(li, (key) => moveByKey(key, f.path));
    return li;
  }

  function fileRow(file) {
    const li = h('li', {
      class: rowClass, role: 'option', 'aria-selected': String(state.selected === file.key), tabindex: '0',
      dataset: { key: file.key },
      draggable: canEdit ? 'true' : undefined,
      onclick: () => select(file),
      onkeydown: (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(file); }
        if (e.key === 'Delete' && canEdit) deleteFile(file);
        if (e.key === 'F2' && canEdit) { e.preventDefault(); renameFile(file); }
      },
      ondragstart: (e) => {
        e.dataTransfer.setData(DRAG_TYPE, file.key);
        e.dataTransfer.effectAllowed = 'move';
        li.classList.add('opacity-50');
      },
      ondragend: () => li.classList.remove('opacity-50'),
    },
    h('div', { class: 'flex min-w-0 items-center gap-3' },
      fileBadge(file.name),
      h('div', { class: 'min-w-0' },
        h('p', { class: 'truncate text-sm font-medium', title: file.name }, file.name),
        h('p', { class: 'text-xs text-slate-500 md:hidden dark:text-slate-400' }, `${formatSize(file.size)} · ${formatDate(file.lastModified)}`))),
    h('span', { class: 'hidden text-right text-sm tabular-nums text-slate-500 md:block dark:text-slate-400' }, formatSize(file.size)),
    h('span', { class: 'hidden text-sm text-slate-500 md:block dark:text-slate-400' }, formatDate(file.lastModified)),
    h('div', { class: 'flex justify-end gap-0.5' },
      actionBtn('download', 'Скачать', () => download(file)),
      actionBtn('link', 'Скопировать ссылку для скачивания', () => copyFileLink(file)),
      canEdit && actionBtn('more', 'Ещё действия', (btn) => openMenu(btn, [
        { label: 'Переименовать', icon: 'pencil', onSelect: () => renameFile(file) },
        { label: 'Переместить…', icon: 'move', onSelect: () => moveFile(file) },
        { label: 'Удалить', icon: 'trash', danger: true, onSelect: () => deleteFile(file) },
      ]))));
    return li;
  }

  function renderList() {
    const match = (name) => !state.query || name.toLowerCase().includes(state.query);
    const folders = state.folders.filter((f) => match(f.name));
    const files = state.files.filter((f) => match(f.name));
    list.replaceChildren(...folders.map(folderRow), ...files.map(fileRow));

    const total = state.files.reduce((s, f) => s + f.size, 0);
    const more = state.cursor ? '+' : '';
    const parts = [];
    if (state.folders.length) parts.push(pluralize(state.folders.length, FOLDERS));
    if (state.files.length || !parts.length) parts.push(`${pluralize(state.files.length, FILES)}${more}`);
    summary.textContent = state.loading && !state.files.length ? 'Загрузка…' : `${parts.join(', ')} · ${formatSize(total)}${more}`;

    const isEmpty = !state.loading && !folders.length && !files.length;
    empty.classList.toggle('hidden', !isEmpty);
    if (isEmpty) {
      empty.replaceChildren(
        h('span', { class: 'mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800' }, icon(state.query ? 'search' : 'folder', 'h-6 w-6')),
        h('p', { class: 'font-medium' }, state.query ? 'Ничего не найдено' : 'Папка пуста'),
        h('p', { class: 'mt-1 text-sm text-slate-500 dark:text-slate-400' },
          state.query ? 'Попробуйте изменить запрос.' : canEdit ? 'Перетащите сюда файлы или нажмите «Загрузить».' : 'Здесь пока нет файлов.'));
    }
    loadMoreWrap.classList.toggle('hidden', !state.cursor);
  }

  function markSelected() {
    for (const li of list.querySelectorAll('li[data-key]')) li.setAttribute('aria-selected', String(li.dataset.key === state.selected));
  }

  function select(file) {
    state.selected = file.key;
    markSelected();
    showPreview(file, canEdit
      ? { folder, onDelete: deleteFile, onRename: renameFile, onMove: moveFile }
      : { folder });
  }

  // ---------- данные ----------
  let loadSeq = 0;
  async function load({ append = false } = {}) {
    const seq = ++loadSeq;
    state.loading = true;
    loadMore.disabled = true;
    try {
      const res = await api.listFolder(folder, append ? state.cursor : undefined);
      if (seq !== loadSeq) return;
      state.files = append ? state.files.concat(res.files) : res.files;
      state.folders = append ? mergeFolders(state.folders, res.folders) : res.folders;
      state.cursor = res.nextCursor;
      tree.setChildren(folder, state.folders);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (seq === loadSeq) {
        state.loading = false;
        loadMore.disabled = false;
        skeleton.remove();
        renderList();
      }
    }
    if (!append && state.selected) {
      const file = state.files.find((f) => f.key === state.selected);
      if (file && !isPreviewing(file.key)) select(file);
    }
  }
  const mergeFolders = (a, b) => [...new Map([...a, ...b].map((f) => [f.path, f])).values()];

  // ---------- действия ----------
  async function download(file) {
    try {
      const { url } = await api.downloadLink(file.key, 3600);
      window.location.assign(url);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteFile(file) {
    if (!(await confirmDialog('Удалить файл?', `«${file.name}» будет удалён без возможности восстановления. Выданные ссылки перестанут работать.`))) return;
    try {
      await api.deleteFile(file.key);
      state.files = state.files.filter((f) => f.key !== file.key);
      if (state.selected === file.key) closePreview();
      renderList();
      ctx.refreshStats();
      toast('Файл удалён', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Применяет результат переименования/перемещения к списку и панели предпросмотра.
  function applyMoved(oldKey, file, targetFolder) {
    const wasSelected = state.selected === oldKey;
    if (targetFolder === folder) {
      state.files = state.files.map((f) => (f.key === oldKey ? file : f));
      if (wasSelected) select(file);
    } else {
      state.files = state.files.filter((f) => f.key !== oldKey);
      if (wasSelected) closePreview();
    }
    renderList();
    ctx.refreshStats();
  }

  async function renameFile(file) {
    const dot = file.name.lastIndexOf('.');
    await openDialog({
      title: 'Переименовать файл',
      text: 'Ссылки на скачивание, выданные раньше, перестанут работать.',
      confirmLabel: 'Переименовать',
      fields: [{ name: 'name', label: 'Новое имя', value: file.name, maxlength: 180,
        select: [0, dot > 0 ? dot : file.name.length] }],
      async onSubmit({ name }) {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Введите имя файла');
        if (trimmed === file.name) return {};
        const res = await api.moveFile(file.key, { name: trimmed });
        applyMoved(file.key, res.file, res.folder);
        toast(`Переименовано в «${res.file.name}»`, 'success');
        return res;
      },
    });
  }

  async function moveFile(file) {
    const target = await pickFolder({ title: `Переместить «${file.name}»`, current: folder });
    if (target !== null) await moveTo(file, target);
  }

  async function moveTo(file, target) {
    if (target === folder) return;
    try {
      const res = await api.moveFile(file.key, { folder: target });
      applyMoved(file.key, res.file, res.folder);
      toast(`«${res.file.name}» перемещён в «${folderLabel(target)}»`, 'success');
    } catch (err) {
      toast(err.message, 'error');
      if (err.status === 404) load();
    }
  }

  // Цель перетаскивания: папка в списке, в дереве или в хлебных крошках.
  function moveByKey(key, target) {
    const file = state.files.find((f) => f.key === key);
    if (file) moveTo(file, target);
  }

  async function deleteFolder(f) {
    if (!(await confirmDialog('Удалить папку?', `Папка «${f.name}» и всё её содержимое (включая вложенные папки) будут удалены без возможности восстановления.`))) return;
    try {
      const { deleted } = await api.deleteFolder(f.path);
      state.folders = state.folders.filter((x) => x.path !== f.path);
      tree.forget(f.path);
      tree.setChildren(folder, state.folders);
      renderList();
      ctx.refreshStats();
      toast(`Папка удалена (объектов: ${deleted})`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function newFolder() {
    await openDialog({
      title: 'Новая папка',
      fields: [{ name: 'name', label: 'Название', maxlength: 100 }],
      confirmLabel: 'Создать',
      async onSubmit({ name }) {
        if (!name.trim()) throw new Error('Введите название папки');
        const { folder: created } = await api.createFolder(folder, name);
        if (!state.folders.some((x) => x.path === created.path)) {
          state.folders = [...state.folders, created].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
        }
        tree.setChildren(folder, state.folders);
        renderList();
        ctx.refreshStats();
        toast(`Папка «${created.name}» создана`, 'success');
      },
    });
  }
  ctx.newFolderHere = canEdit ? newFolder : null;

  // ---------- drag-and-drop по всей области ----------
  if (canEdit) {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const show = (on) => { overlay.classList.toggle('hidden', !on); overlay.classList.toggle('flex', on); };
    const handlers = {
      dragenter: (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; show(true); },
      dragleave: (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) show(false); },
      dragover: (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
      drop: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        show(false);
        const files = [...e.dataTransfer.items]
          .filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
          .map((item) => item.getAsFile())
          .filter(Boolean);
        if (files.length) ctx.enqueue(files, folder);
        else toast('Папки целиком не поддерживаются — перетащите сами файлы', 'error');
      },
    };
    for (const [type, fn] of Object.entries(handlers)) {
      window.addEventListener(type, fn);
      cleanup.push(() => window.removeEventListener(type, fn));
    }
  }

  load();

  return {
    // Загрузка завершилась: если файл в этой папке — добавляем его сверху.
    onUploaded(file, targetFolder) {
      if (targetFolder !== folder || state.files.some((f) => f.key === file.key)) return;
      state.files.unshift(file);
      renderList();
    },
    unmount() {
      cleanup.forEach((fn) => fn());
      ctx.newFolderHere = null;
      tree.setDropHandler(null);
      ctx.onPreviewClosed = null;
      setPreviewEnabled(false);
      tree.clearActive();
    },
  };
}
