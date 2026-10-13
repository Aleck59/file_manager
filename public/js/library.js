// «Избранное» и «Недавно открытые» — хранятся в браузере (localStorage), отдельно для
// каждого пользователя. Сервер о них не знает: это личные закладки, а не общие данные.
// При переименовании/перемещении/удалении файла записи обновляются (rename/remove).
import { prefs } from './ui.js';

const MAX_RECENT = 12;
const MAX_FAVORITES = 50;
const listeners = new Set();
let user = '';

const read = (name) => {
  try {
    const value = JSON.parse(prefs.get(`${name}:${user}`, '[]'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};
const write = (name, list) => {
  prefs.set(`${name}:${user}`, JSON.stringify(list));
  for (const fn of listeners) fn();
};

export function initLibrary(username) {
  user = username;
}

export const onLibraryChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// ---------- избранное ----------
// Запись: { type: 'folder', path, name } или { type: 'file', key, name, folder }
const id = (item) => (item.type === 'folder' ? `d:${item.path}` : `f:${item.key}`);

export const favorites = () => read('favorites');
export const isFavorite = (item) => favorites().some((x) => id(x) === id(item));

/** Добавляет или убирает из избранного; возвращает новое состояние. */
export function toggleFavorite(item) {
  const list = favorites();
  const i = list.findIndex((x) => id(x) === id(item));
  if (i >= 0) list.splice(i, 1);
  else list.unshift(item);
  write('favorites', list.slice(0, MAX_FAVORITES));
  return i < 0;
}

// ---------- недавно открытые ----------
export const recentFiles = () => read('recent');

export function rememberOpened(file, folder) {
  const list = recentFiles().filter((x) => x.key !== file.key);
  list.unshift({ key: file.key, name: file.name, folder, size: file.size, at: new Date().toISOString() });
  write('recent', list.slice(0, MAX_RECENT));
}

// ---------- согласование с изменениями файлов ----------
export function renameInLibrary(oldKey, file, folder) {
  for (const name of ['favorites', 'recent']) {
    const list = read(name);
    let changed = false;
    for (const item of list) {
      if (item.key === oldKey) Object.assign(item, { key: file.key, name: file.name, folder }), (changed = true);
    }
    if (changed) write(name, list);
  }
}

export function removeFromLibrary(keys) {
  const gone = new Set(keys);
  for (const name of ['favorites', 'recent']) {
    const list = read(name);
    const next = list.filter((item) => !gone.has(item.key));
    if (next.length !== list.length) write(name, next);
  }
}

export function forgetFolder(path) {
  for (const name of ['favorites', 'recent']) {
    const list = read(name);
    const next = list.filter((item) => !(item.path ?? item.folder ?? '').startsWith(path));
    if (next.length !== list.length) write(name, next);
  }
}
