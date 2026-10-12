// Ключи объектов в S3 и папки.
//
// Папка — это S3-префикс, заканчивающийся на "/". Пустая папка хранится как
// объект-маркер нулевой длины с ключом "<prefix><path>/" (общепринятое соглашение S3).
//
// Файл:  <prefix><папка><время-по-убыванию>-<id>~<имя файла>
//   - инвертированная метка времени даёт сортировку «новые сверху» прямо в ListObjectsV2;
//   - 96 бит случайности делают ключ неугадываемым;
//   - файл лежит одним сегментом прямо в папке, поэтому ListObjectsV2 с Delimiter="/"
//     отдаёт файлы папки в Contents, а подпапки — в CommonPrefixes.
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';

const MAX_TS = 9_999_999_999_999; // ~ год 2286
const MAX_NAME_LENGTH = 180;
const MAX_FOLDER_SEGMENT = 100;
const MAX_FOLDER_DEPTH = 20;
const ID_LENGTH = 26; // 9 (время) + 1 + 16 (случайная часть)

// S3_PREFIX можно сменить в настройках на лету — читаем при каждом обращении.
const prefix = () => config.s3.prefix;
const FILE_SEGMENT_RE = /^[0-9a-z]{9}-[A-Za-z0-9_-]{16}~[^/]+$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = '\\u0000-\\u001f\\u007f-\\u009f/\\\\:*?"<>|';
const UNSAFE_CHARS_RE = new RegExp(`[${UNSAFE_CHARS}]`, 'g');
const HAS_UNSAFE_RE = new RegExp(`[${UNSAFE_CHARS}]`);

function clean(input) {
  return String(input ?? '')
    .normalize('NFC')
    .replace(UNSAFE_CHARS_RE, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeFileName(input) {
  let name = clean(input).replace(/^\.+/, '');
  if (!name) name = 'file';
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return name;
}

// Имя новой папки от пользователя: возвращает безопасное имя или null.
export function sanitizeFolderName(input) {
  const name = clean(input).replace(/^\.+/, '').slice(0, MAX_FOLDER_SEGMENT).trim();
  return name || null;
}

function isValidSegment(seg) {
  return (
    seg.length > 0 && seg.length <= MAX_FOLDER_SEGMENT && seg !== '.' && seg !== '..' &&
    seg === seg.trim() && !HAS_UNSAFE_RE.test(seg)
  );
}

// Путь папки относительно S3_PREFIX: "" (корень) или "a/b/" — всегда со слешем на конце.
export function isValidFolder(folder) {
  if (folder === '') return true;
  if (typeof folder !== 'string' || folder.length > 1000 || !folder.endsWith('/')) return false;
  const segments = folder.slice(0, -1).split('/');
  return segments.length <= MAX_FOLDER_DEPTH && segments.every(isValidSegment);
}

export function folderToPrefix(folder) {
  return prefix() + folder;
}

export function generateKey(fileName, folder = '') {
  const inverted = (MAX_TS - Date.now()).toString(36).padStart(9, '0');
  const random = crypto.randomBytes(12).toString('base64url');
  return `${prefix()}${folder}${inverted}-${random}~${sanitizeFileName(fileName)}`;
}

// Любой ключ, пришедший от клиента, обязан пройти эту проверку —
// иначе через API можно было бы удалить/скачать произвольный объект бакета.
export function isValidKey(key) {
  if (typeof key !== 'string' || key.length > 1200 || !key.startsWith(prefix())) return false;
  const rel = key.slice(prefix().length);
  const slash = rel.lastIndexOf('/');
  const folder = rel.slice(0, slash + 1);
  return FILE_SEGMENT_RE.test(rel.slice(slash + 1)) && isValidFolder(folder);
}

export function nameFromKey(key) {
  return key.slice(key.lastIndexOf('/') + 1).slice(ID_LENGTH + 1);
}

// Ключ после переименования/перемещения. Идентификатор (метка времени + случайная часть)
// сохраняется — файл остаётся на своём месте в сортировке «новые сверху».
export function rebuildKey(key, { folder = folderFromKey(key), name = nameFromKey(key) } = {}) {
  const segment = key.slice(key.lastIndexOf('/') + 1);
  return `${prefix()}${folder}${segment.slice(0, ID_LENGTH)}~${sanitizeFileName(name)}`;
}

export function folderFromKey(key) {
  const rel = key.slice(prefix().length);
  return rel.slice(0, rel.lastIndexOf('/') + 1);
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/i;

export function safeContentType(type) {
  return typeof type === 'string' && MIME_RE.test(type) ? type.toLowerCase() : 'application/octet-stream';
}

// RFC 6266 / RFC 5987: ASCII-fallback + UTF-8 имя для кириллицы и пр.
export function contentDisposition(name, type = 'attachment') {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// ---------- предпросмотр ----------
// Белый список: для предпросмотра сервер сам задаёт Content-Type ответа S3.
// Всё текстовое (включая .html, .svg-исходники и т.п.) отдаётся как text/plain —
// браузер никогда не исполнит загруженный пользователем код.
const PREVIEW_TYPES = {
  image: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' },
  video: { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/mp4' },
  audio: { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4',
    aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg' },
  pdf: { pdf: 'application/pdf' },
};
const TEXT_EXT = new Set(('txt md markdown csv tsv log json jsonl xml yml yaml toml ini conf cfg env ' +
  'js mjs cjs ts tsx jsx css scss less html htm vue svelte py rb php go rs java kt kts c h cpp hpp cs swift ' +
  'sh bash zsh ps1 bat sql graphql proto dockerfile makefile gitignore editorconfig srt vtt tex rst').split(' '));

export function extOf(name) {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : path.basename(base);
}

export function previewKind(name) {
  const ext = extOf(name);
  for (const [kind, map] of Object.entries(PREVIEW_TYPES)) {
    if (map[ext]) return { kind, contentType: map[ext] };
  }
  if (TEXT_EXT.has(ext)) return { kind: 'text', contentType: 'text/plain; charset=utf-8' };
  return null;
}

export function categoryOf(name) {
  const ext = extOf(name);
  const kind = previewKind(name)?.kind;
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'].includes(ext)) return 'archive';
  if (kind === 'pdf' || kind === 'text' ||
    ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key'].includes(ext)) {
    return 'document';
  }
  return 'other';
}
