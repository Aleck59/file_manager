// Короткий ID папки для адреса страницы: #/disk/<ID> вместо полного пути (длинный путь из
// десятка вложенных папок не помещается в адрес). ID — хеш пути (cyrb53, 53 бита, 11 символов):
// браузер считает его сам, без запроса к серверу; сервер по ID находит путь (src/folder-ids.js).
// Тот же код — в src/folder-ids.js: менять только вместе.
export function folderId(path) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < path.length; i++) {
    const ch = path.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, '0');
}

export const FOLDER_ID_RE = /^[0-9a-z]{11}$/;
