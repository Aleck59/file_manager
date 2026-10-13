// WebDAV: диск как сетевая папка — Проводник Windows, Finder (macOS), Nautilus, rclone,
// Cyberduck, приложения на телефоне. Адрес: <APP_ORIGIN>/dav/
//
// Вход — Basic-авторизация: логин + пароль или API-токен вместо пароля (обязательно, если у
// пользователя включена 2FA; токен «только чтение» запрещает изменения). Действуют роли и права
// на папки. Включается настройкой WEBDAV_ENABLED.
//
// Пути — человеческие: /dav/Документы/отчёт.pdf. Внутри папки имена файлов могут совпадать
// (у каждого свой ключ) — по WebDAV виден самый новый. Файлы читаются и пишутся потоком через
// сервер (в памяти — одна часть по 5 МБ); удаление — в корзину.
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import * as acl from './acl.js';
import * as apiTokens from './api-tokens.js';
import { authenticate, hasRole } from './auth.js';
import * as auditLog from './audit-log.js';
import { config } from './config.js';
import {
  formatRef, generateKey, isValidFolder, isValidKey, rebuildKey, sanitizeFileName, sanitizeFolderName,
} from './keys.js';
import * as labels from './labels.js';
import * as sharesStore from './shares.js';
import * as storages from './storages.js';
import * as trash from './trash.js';
import { streamInto } from './url-import.js';
import { getUser } from './users.js';
import { personalUsage } from './routes/files.js';

const PREFIX = '/dav';
const MAX_LIST = 10_000;
const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------- вход ----------
// scrypt на каждый запрос был бы слишком медленным (клиенты шлют десятки запросов подряд):
// успешную пару логин/пароль помним 5 минут по её хешу.
const authCache = new Map(); // sha256(заголовок) → {username, readOnly, until}
const failures = new Map(); // ip → {count, reset}

function rateLimited(ip) {
  const f = failures.get(ip);
  if (!f || f.reset < Date.now()) return false;
  return f.count >= 10;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.reset < Date.now()) failures.set(ip, { count: 1, reset: Date.now() + 15 * 60_000 });
  else f.count += 1;
}

async function authenticateDav(req) {
  const header = req.headers.authorization ?? '';
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (!m) return null;
  const id = crypto.createHash('sha256').update(header).digest('base64url');
  const cached = authCache.get(id);
  if (cached && cached.until > Date.now()) {
    const user = getUser(cached.username);
    return user ? { user, readOnly: cached.readOnly } : null;
  }
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 1) return null;
  const username = decoded.slice(0, i).toLowerCase();
  const secret = decoded.slice(i + 1);
  let result = null;
  if (secret.startsWith('fmt_')) {
    const token = apiTokens.verify(`Bearer ${secret}`, req.ip);
    const user = token && token.user === username ? getUser(username) : null;
    if (user) result = { user, readOnly: token.readOnly };
  } else if (secret.length <= 256) {
    const user = await authenticate(username, secret);
    // С 2FA пароля мало: нужен API-токен (код из приложения WebDAV-клиент спросить не может).
    if (user && !user.totp) result = { user, readOnly: false };
  }
  if (result) {
    if (authCache.size > 200) authCache.clear();
    authCache.set(id, { username: result.user.username, readOnly: result.readOnly, until: Date.now() + 5 * 60_000 });
  }
  return result;
}

// ---------- пути ----------
function parsePath(raw) {
  let decoded;
  try {
    decoded = decodeURIComponent(raw.split('?')[0]);
  } catch {
    throw fail(400, 'Некорректный путь');
  }
  const segs = decoded.split('/').filter(Boolean);
  if (segs.some((s) => s === '.' || s === '..')) throw fail(400, 'Некорректный путь');
  return segs;
}

const folderOf = (segs) => (segs.length ? `${segs.join('/')}/` : '');
const href = (folder, name = '', isDir = false) => {
  const parts = [...folder.split('/').filter(Boolean), ...(name ? [name] : [])];
  return `${PREFIX}/${parts.map(encodeURIComponent).join('/')}${(isDir || !name) && parts.length ? '/' : ''}`.replace(/\/\/$/, '/');
};

// Содержимое папки (все страницы), кеш на 5 с: клиенты запрашивают одну папку много раз подряд.
const listCache = new Map();
function invalidate(folder) {
  for (const k of listCache.keys()) if (k === folder || k.startsWith(folder) || folder.startsWith(k)) listCache.delete(k);
}
async function listAll(folder) {
  const hit = listCache.get(folder);
  if (hit && hit.until > Date.now()) return hit.data;
  const folders = [];
  const files = new Map(); // имя → самый новый файл
  let cursor;
  do {
    const page = await storages.listFolder(folder, { cursor, limit: 1000 });
    folders.push(...page.folders);
    for (const f of page.files) {
      const prev = files.get(f.name);
      if (!prev || (f.lastModified ?? '') > (prev.lastModified ?? '')) files.set(f.name, f);
    }
    cursor = page.nextCursor;
  } while (cursor && folders.length + files.size < MAX_LIST);
  const data = { folders, files };
  if (listCache.size > 50) listCache.clear();
  listCache.set(folder, { data, until: Date.now() + 5000 });
  return data;
}

/** Что по пути: {type:'folder', path} | {type:'file', file, folder} | null (нет такого). */
async function resolve(segs) {
  if (!segs.length) return { type: 'folder', path: '' };
  const parent = folderOf(segs.slice(0, -1));
  const name = segs.at(-1);
  if (!isValidFolder(parent)) return null;
  const { folders, files } = await listAll(parent);
  const asFolder = `${parent}${name}/`;
  if (folders.some((f) => f.path === asFolder)) return { type: 'folder', path: asFolder };
  const file = files.get(name);
  return file ? { type: 'file', file, folder: parent } : null;
}

// ---------- XML ----------
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const httpDate = (iso) => new Date(iso ?? Date.now()).toUTCString();

function propXml(entry) {
  const p = [`<d:displayname>${esc(entry.name)}</d:displayname>`];
  if (entry.dir) {
    p.push('<d:resourcetype><d:collection/></d:resourcetype>');
  } else {
    p.push('<d:resourcetype/>', `<d:getcontentlength>${entry.size}</d:getcontentlength>`,
      `<d:getcontenttype>${esc(entry.type)}</d:getcontenttype>`, `<d:getetag>"${esc(entry.etag)}"</d:getetag>`);
  }
  p.push(`<d:getlastmodified>${httpDate(entry.modified)}</d:getlastmodified>`,
    '<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>');
  return `<d:response><d:href>${esc(entry.href)}</d:href><d:propstat><d:prop>${p.join('')}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}
const fileEntry = (f, folder) => ({
  href: href(folder, f.name), name: f.name, size: f.size, modified: f.lastModified,
  type: typeFor(f.name), etag: crypto.createHash('sha1').update(`${f.key}|${f.size}|${f.lastModified}`).digest('hex').slice(0, 20),
});
const folderEntry = (path) => ({ href: href(path, '', true) || `${PREFIX}/`, name: path.slice(0, -1).split('/').pop() || 'Мой диск', dir: true, modified: null });

const TYPES = { pdf: 'application/pdf', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip' };
function typeFor(name) {
  const ext = name.toLowerCase().split('.').pop();
  return TYPES[ext] ?? 'application/octet-stream';
}

function multistatus(res, entries) {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${entries.map(propXml).join('')}</d:multistatus>`;
  res.statusCode = 207;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

// ---------- обработчики ----------
function needWrite(ctx, folder) {
  if (ctx.readOnly) throw fail(403, 'Токен только для чтения');
  if (!hasRole(ctx.user, 'editor') || !acl.canWrite(ctx.user, folder)) throw fail(403, 'Нет прав на изменения в этой папке');
}

async function propfind(req, res, ctx, segs) {
  const target = await resolve(segs);
  if (!target) throw fail(404, 'Не найдено');
  if (target.type === 'file') {
    if (!acl.canRead(ctx.user, target.folder)) throw fail(404, 'Не найдено');
    return multistatus(res, [fileEntry(target.file, target.folder)]);
  }
  if (!acl.canSee(ctx.user, target.path)) throw fail(404, 'Не найдено');
  const entries = [folderEntry(target.path)];
  if (req.headers.depth !== '0') {
    const { folders, files } = await listAll(target.path);
    for (const f of folders) if (acl.canSee(ctx.user, f.path)) entries.push(folderEntry(f.path));
    if (acl.canRead(ctx.user, target.path)) for (const f of files.values()) entries.push(fileEntry(f, target.path));
  }
  multistatus(res, entries);
}

async function get(req, res, ctx, segs) {
  const target = await resolve(segs);
  if (!target) throw fail(404, 'Не найдено');
  if (target.type === 'folder') {
    if (!acl.canSee(ctx.user, target.path)) throw fail(404, 'Не найдено');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Это папка WebDAV. Подключите адрес как сетевой диск.\n');
  }
  if (!acl.canRead(ctx.user, target.folder)) throw fail(404, 'Не найдено');
  const { st, rel } = storages.resolveRef(target.file.key);
  const size = target.file.size;
  // Файл с диска не должен исполниться на нашем домене (HTML, SVG): только как вложение, в песочнице.
  res.setHeader('Content-Type', typeFor(target.file.name));
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Security-Policy', 'sandbox; default-src \'none\'');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', httpDate(target.file.lastModified));
  res.setHeader('ETag', `"${fileEntry(target.file, target.folder).etag}"`);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = size - 1;
  if (range && size > 0) {
    start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', size ? end - start + 1 : 0);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const body = res.statusCode === 206 ? await st.getRangeStream(rel, start, end) : (await st.getStream(rel)).body;
  try {
    await pipeline(body, res);
  } catch {
    res.destroy();
  }
}

async function put(req, res, ctx, segs) {
  if (!segs.length) throw fail(405, 'Нельзя записать файл вместо корня');
  const folder = folderOf(segs.slice(0, -1));
  const name = sanitizeFileName(segs.at(-1));
  if (!name || !isValidFolder(folder)) throw fail(400, 'Некорректное имя');
  needWrite(ctx, folder);
  const existing = await resolve(segs);
  if (existing?.type === 'folder') throw fail(405, 'Здесь папка');
  const declared = Number(req.headers['content-length']);
  const size = Number.isSafeInteger(declared) ? declared : 0;
  if (size > config.limits.maxFileSize) throw fail(413, 'Файл больше допустимого размера');
  const st = await storages.pickForUpload(size);
  const rel = generateKey(name, folder);
  if (!isValidKey(rel)) throw fail(400, 'Слишком длинный путь или имя');
  // Квота личной папки — как при загрузке через сайт.
  let max = config.limits.maxFileSize;
  if (ctx.user.quotaMb && acl.inPersonal(ctx.user, folder)) {
    const left = ctx.user.quotaMb * 1024 * 1024 - await personalUsage(ctx.user);
    if (left <= 0 || size > left) throw fail(507, 'Не хватает места в личной папке');
    max = Math.min(max, left);
  }
  const job = { loaded: 0, max, controller: new AbortController() };
  let uploadId = null;
  try {
    await streamInto(st, rel, typeFor(name), req, job, (id) => { uploadId = id; });
  } catch (err) {
    if (uploadId) await st.abortMultipart(rel, uploadId).catch(() => {});
    throw fail(err.status ?? 400, err.message);
  }
  storages.noteUploaded(st.id, job.loaded);
  // Перезапись: новый файл уже на месте, прежний удаляем (метка и ссылки переходят к новому).
  if (existing?.type === 'file') {
    const old = storages.resolveRef(existing.file.key);
    await old.st.deleteObject(old.rel).catch(() => {});
    labels.rekey(existing.file.key, formatRef(st.id, rel));
    sharesStore.rekeyFile(existing.file.key, formatRef(st.id, rel));
  }
  storages.invalidateStats();
  invalidate(folder);
  auditLog.record({ user: ctx.user.username, action: 'file.upload', ip: req.ip, details: { via: 'webdav', storage: st.id, key: rel, size: job.loaded } });
  res.statusCode = existing ? 204 : 201;
  res.end();
}

async function remove(req, res, ctx, segs) {
  const target = await resolve(segs);
  if (!target || !segs.length) throw fail(404, 'Не найдено');
  // Скрытое от пользователя — «не найдено», а не «нет прав»: не раскрываем, что оно есть.
  if (!acl.canRead(ctx.user, target.type === 'file' ? target.folder : target.path)) throw fail(404, 'Не найдено');
  if (target.type === 'file') {
    needWrite(ctx, target.folder);
    const { st, rel } = storages.resolveRef(target.file.key);
    if (trash.enabled()) await trash.trashFiles([{ st, rel }], ctx.user.username);
    else { await st.deleteObject(rel); labels.forget(target.file.key); }
    sharesStore.fileGone(target.file.key);
    invalidate(target.folder);
  } else {
    needWrite(ctx, target.path);
    if (!acl.canWriteTree(ctx.user, target.path) || acl.isPersonalRoot(target.path)) throw fail(403, 'Нет прав на эту папку');
    if (trash.enabled()) await trash.trashFolder(target.path, ctx.user.username);
    else { await storages.deleteFolder(target.path); labels.forgetFolder(target.path); acl.forgetFolder(target.path); }
    sharesStore.folderGone(target.path);
    invalidate(target.path);
  }
  storages.invalidateStats();
  auditLog.record({ user: ctx.user.username, action: trash.enabled() ? 'file.trash' : 'file.delete', ip: req.ip, details: { via: 'webdav', path: segs.join('/') } });
  res.statusCode = 204;
  res.end();
}

async function mkcol(req, res, ctx, segs) {
  if (!segs.length) throw fail(405, 'Корень уже есть');
  const parent = folderOf(segs.slice(0, -1));
  const name = sanitizeFolderName(segs.at(-1));
  if (!name || name !== segs.at(-1)) throw fail(400, 'Недопустимое имя папки');
  needWrite(ctx, parent);
  if (await resolve(segs)) throw fail(405, 'Уже существует'); // скрытая папка с таким именем тоже «занимает» место
  const path = `${parent}${name}/`;
  if (!isValidFolder(path)) throw fail(400, 'Слишком глубокая вложенность');
  await storages.createFolder(path);
  invalidate(parent);
  res.statusCode = 201;
  res.end();
}

function destinationOf(req) {
  const dest = req.headers.destination;
  if (!dest) throw fail(400, 'Нет заголовка Destination');
  let pathname;
  try {
    pathname = new URL(dest, config.appOrigin).pathname;
  } catch {
    throw fail(400, 'Некорректный Destination');
  }
  if (!pathname.startsWith(`${PREFIX}/`)) throw fail(502, 'Destination вне WebDAV');
  return parsePath(pathname.slice(PREFIX.length));
}

async function moveOrCopy(req, res, ctx, segs, copy) {
  const target = await resolve(segs);
  if (!target || !segs.length || !acl.canRead(ctx.user, target.type === 'file' ? target.folder : target.path)) throw fail(404, 'Не найдено');
  const destSegs = destinationOf(req);
  if (!destSegs.length) throw fail(403, 'Нельзя заменить корень');
  const destFolder = folderOf(destSegs.slice(0, -1));
  const overwrite = (req.headers.overwrite ?? 'T').toUpperCase() !== 'F';
  needWrite(ctx, destFolder);
  const existing = await resolve(destSegs);
  if (existing && !overwrite) throw fail(412, 'Уже существует');

  if (target.type === 'file') {
    if (!acl.canRead(ctx.user, target.folder)) throw fail(404, 'Не найдено');
    if (!copy) needWrite(ctx, target.folder);
    if (existing?.type === 'folder') throw fail(409, 'На этом месте папка');
    const name = sanitizeFileName(destSegs.at(-1));
    const { st, rel } = storages.resolveRef(target.file.key);
    const head = await st.headObject(rel);
    if (!head) throw fail(404, 'Не найдено');
    const dst = copy ? generateKey(name, destFolder) : rebuildKey(rel, { folder: destFolder, name });
    if (!isValidKey(dst)) throw fail(400, 'Слишком длинный путь или имя');
    if (dst !== rel) {
      await st.copyObject(rel, dst, head.ContentLength ?? 0, head.ContentType, head.StorageClass ?? st.storageClass);
      if (!copy) {
        await st.deleteObject(rel);
        sharesStore.rekeyFile(target.file.key, formatRef(st.id, dst));
        labels.rekey(target.file.key, formatRef(st.id, dst));
      }
    }
    if (existing?.type === 'file' && existing.file.key !== target.file.key) {
      const old = storages.resolveRef(existing.file.key);
      await old.st.deleteObject(old.rel).catch(() => {});
    }
  } else {
    const destPath = `${destFolder}${sanitizeFolderName(destSegs.at(-1))}/`;
    if (!isValidFolder(destPath) || destPath.startsWith(target.path)) throw fail(403, 'Нельзя переместить папку внутрь неё самой');
    if (!copy && (!acl.canWriteTree(ctx.user, target.path) || acl.isPersonalRoot(target.path))) throw fail(403, 'Нет прав на эту папку');
    if (existing) throw fail(existing.type === 'folder' ? 412 : 409, 'На этом месте уже что-то есть');
    if (copy) {
      await storages.everywhere(async (st) => {
        await st.forEachObject(target.path, async (o) => {
          await st.copyObject(o.rel, destPath + o.rel.slice(target.path.length), o.size, undefined, o.storageClass ?? st.storageClass);
        });
      });
    } else {
      await storages.moveFolder(target.path, destPath);
      sharesStore.refolder(target.path, destPath);
      labels.refolder(target.path, destPath);
      acl.refolder(target.path, destPath);
    }
  }
  storages.invalidateStats();
  invalidate(target.type === 'file' ? target.folder : target.path);
  invalidate(destFolder);
  auditLog.record({ user: ctx.user.username, action: copy ? 'file.copy' : 'file.move', ip: req.ip, details: { via: 'webdav', from: segs.join('/'), to: destSegs.join('/') } });
  res.statusCode = existing ? 204 : 201;
  res.end();
}

// Блокировки: настоящих нет (файл в S3 и так пишется целиком), но Finder и Windows без
// ответа на LOCK открывают диск только для чтения. Отдаём формальную блокировку.
async function lock(req, res, ctx) {
  for await (const _ of req) { /* тело не нужно */ }
  if (ctx.readOnly) throw fail(403, 'Токен только для чтения');
  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>0</d:depth><d:owner>${esc(ctx.user.username)}</d:owner><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`;
  res.statusCode = 200;
  res.setHeader('Lock-Token', `<${token}>`);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.end(body);
}

// PROPPATCH (Windows записывает время файла) — принимаем и ничего не меняем.
async function proppatch(req, res, segs) {
  for await (const _ of req) { /* тело не нужно */ }
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:"><d:response><d:href>${esc(href(folderOf(segs.slice(0, -1)), segs.at(-1) ?? ''))}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  res.statusCode = 207;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.end(body);
}

const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK';
const READ_METHODS = new Set(['OPTIONS', 'GET', 'HEAD', 'PROPFIND']);

export async function webdav(req, res) {
  res.setHeader('DAV', '1, 2');
  res.setHeader('MS-Author-Via', 'DAV');
  if (!config.webdav) {
    res.statusCode = 404;
    return res.end('WebDAV выключен (Настройки → Пользователи и вход)');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', ALLOW);
    res.statusCode = 200;
    return res.end();
  }
  if (rateLimited(req.ip)) {
    res.statusCode = 429;
    return res.end('Слишком много неудачных попыток входа, попробуйте позже');
  }
  const ctx = await authenticateDav(req);
  if (!ctx) {
    if (req.headers.authorization) {
      noteFailure(req.ip);
      console.warn(`[auth] неудачный вход WebDAV ip=${req.ip}`);
      auditLog.record({ user: '-', action: 'auth.fail', ip: req.ip, details: { via: 'webdav' } });
    }
    res.statusCode = 401;
    // В заголовках HTTP допустим только ASCII: кириллическое название сайта сюда не годится.
    const realm = (config.appName || '').replace(/[^\x20-\x7e]|"/g, '').trim() || 'File manager';
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    return res.end('Требуется вход');
  }
  if (ctx.readOnly && !READ_METHODS.has(req.method)) {
    res.statusCode = 403;
    return res.end('Токен только для чтения');
  }
  try {
    const segs = parsePath(req.routePath ?? '/');
    switch (req.method) {
      case 'PROPFIND': return await propfind(req, res, ctx, segs);
      case 'GET': case 'HEAD': return await get(req, res, ctx, segs);
      case 'PUT': return await put(req, res, ctx, segs);
      case 'DELETE': return await remove(req, res, ctx, segs);
      case 'MKCOL': return await mkcol(req, res, ctx, segs);
      case 'MOVE': return await moveOrCopy(req, res, ctx, segs, false);
      case 'COPY': return await moveOrCopy(req, res, ctx, segs, true);
      case 'LOCK': return await lock(req, res, ctx);
      case 'UNLOCK': res.statusCode = 204; return res.end();
      case 'PROPPATCH': return await proppatch(req, res, segs);
      default:
        res.statusCode = 405;
        res.setHeader('Allow', ALLOW);
        return res.end();
    }
  } catch (err) {
    if (res.headersSent) return res.destroy();
    const status = err.status ?? (err.name === 'NoSuchKey' ? 404 : 500);
    if (status >= 500) console.error('[webdav]', req.method, err?.name, err?.message);
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(status >= 500 ? 'Ошибка сервера' : err.message);
  }
}
