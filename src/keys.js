// Генерация и проверка ключей объектов в S3.
// Формат: <prefix><время-по-убыванию>-<случайный id>/<безопасное имя файла>
// Инвертированная метка времени даёт сортировку «новые сверху» прямо в ListObjectsV2,
// а 96 бит случайности делают ключ неугадываемым.
import crypto from 'node:crypto';
import { config } from './config.js';

const MAX_TS = 9_999_999_999_999; // ~ год 2286
const MAX_NAME_LENGTH = 180;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEY_RE = new RegExp(`^${escapeRegExp(config.s3.prefix)}[0-9a-z]{9}-[A-Za-z0-9_-]{16}/[^/]+$`);

export function sanitizeFileName(input) {
  let name = String(input ?? '')
    .normalize('NFC')
    // управляющие символы, разделители путей и символы, ломающие заголовки/ОС
    .replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!name) name = 'file';
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return name;
}

export function generateKey(fileName) {
  const inverted = (MAX_TS - Date.now()).toString(36).padStart(9, '0');
  const random = crypto.randomBytes(12).toString('base64url');
  return `${config.s3.prefix}${inverted}-${random}/${sanitizeFileName(fileName)}`;
}

// Любой ключ, пришедший от клиента, обязан пройти эту проверку —
// иначе через API можно было бы удалить/скачать произвольный объект бакета.
export function isValidKey(key) {
  return typeof key === 'string' && key.length <= 512 && KEY_RE.test(key);
}

export function nameFromKey(key) {
  return key.slice(key.lastIndexOf('/') + 1);
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/i;

export function safeContentType(type) {
  return typeof type === 'string' && MIME_RE.test(type) ? type.toLowerCase() : 'application/octet-stream';
}

// RFC 6266 / RFC 5987: ASCII-fallback + UTF-8 имя для кириллицы и пр.
export function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
