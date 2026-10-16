// Публичные ссылки: управление (вошедшие, «Редактор» и выше) и гостевая часть (/api/public/s).
import * as acl from '../acl.js';
import { hasRole, requireRole } from '../auth.js';
import { config } from '../config.js';
import { Router } from '../http.js';
import { folderFromKey, formatRef, isReservedFolder, isValidFolder, nameFromKey, parseRef, previewKind } from '../keys.js';
import { audit, HttpError, rateLimit } from '../middleware/security.js';
import * as shares from '../shares.js';
import * as storages from '../storages.js';
import * as uploadFlow from '../upload-flow.js';
import { getUser } from '../users.js';

const MB = 1024 * 1024;
const DOWNLOAD_TTL = 10 * 60;
const folderLabel = (f) => ['Мой диск', ...f.split('/').filter(Boolean)].join(' / ');
const wrap = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof HttpError || !err.status ? err : new HttpError(err.status, err.message);
  }
};

const wrapSync = (fn) => {
  try {
    return fn();
  } catch (err) {
    throw err instanceof HttpError || !err.status ? err : new HttpError(err.status, err.message);
  }
};

// ---------- управление ----------
export const sharesRouter = Router();
sharesRouter.use(requireRole('editor'));

// GET /api/shares[?all=1] — мои ссылки (администратор может все)
sharesRouter.get('/', (req, res) => {
  const all = req.query.all === '1' && hasRole(req.user, 'admin');
  res.json({ shares: shares.listFor(req.user.username, all) });
});

// POST /api/shares {type, key|folder, expiresInDays, password, maxDownloads, maxUploads, maxFileSizeMb}
sharesRouter.post('/', async (req, res) => {
  const b = req.body ?? {};
  let name;
  if (b.type === 'file') {
    const { st, rel } = storages.resolveRef(b.key);
    if (!acl.canRead(req.user, folderFromKey(rel)) || !(await st.headObject(rel))) throw new HttpError(404, 'Файл не найден');
    name = nameFromKey(rel);
  } else if (b.type === 'folder' || b.type === 'upload') {
    if (!isValidFolder(b.folder ?? '') || isReservedFolder(b.folder ?? '')) throw new HttpError(400, 'Некорректный путь папки');
    if (!acl.canRead(req.user, b.folder ?? '')) throw new HttpError(404, 'Папка не найдена');
    if (b.type === 'upload' && !acl.canWrite(req.user, b.folder ?? '')) throw new HttpError(403, 'Нет прав на загрузку в эту папку');
    name = folderLabel(b.folder ?? '');
  } else {
    throw new HttpError(400, 'Неизвестный вид ссылки');
  }
  const share = await wrap(() => shares.create({ ...b, folder: b.folder ?? '', name, user: req.user.username }));
  audit(req, 'share.create', { id: share.id, type: share.type, name, expiresAt: share.expiresAt, password: Boolean(share.passwordHash) });
  res.status(201).json({ share: shares.ownerView(share) });
});

sharesRouter.post('/:id/revoke', (req, res) => {
  if (!shares.revoke(req.params.id, req.user.username, hasRole(req.user, 'admin'))) throw new HttpError(404, 'Ссылка не найдена');
  audit(req, 'share.revoke', { id: req.params.id });
  res.json({ ok: true });
});

// GET /api/shares/:id/stats — статистика портала загрузки (кто, когда, откуда, что)
sharesRouter.get('/:id/stats', (req, res) => {
  const s = shares.get(req.params.id);
  if (!s || (s.createdBy !== req.user.username && !hasRole(req.user, 'admin'))) throw new HttpError(404, 'Ссылка не найдена');
  res.json(shares.statsOf(s));
});

// PATCH /api/shares/:id {slug?, caption?} — короткий адрес и подпись
sharesRouter.patch('/:id', (req, res) => {
  const s = wrapSync(() => shares.update(req.params.id, req.user.username, hasRole(req.user, 'admin'), { slug: req.body?.slug, caption: req.body?.caption }));
  if (!s) throw new HttpError(404, 'Ссылка не найдена');
  audit(req, 'share.update', { id: s.id, slug: s.slug });
  res.json({ share: shares.ownerView(s) });
});

sharesRouter.delete('/:id', (req, res) => {
  if (!shares.remove(req.params.id, req.user.username, hasRole(req.user, 'admin'))) throw new HttpError(404, 'Ссылка не найдена');
  res.json({ ok: true });
});

// ---------- гостевая часть ----------
export const publicSharesRouter = Router();
publicSharesRouter.use(rateLimit({ windowMs: 60_000, max: 120 }));
const unlockLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, message: 'Слишком много попыток ввода пароля, попробуйте позже' });

const STATE_TEXT = {
  expired: 'Срок действия ссылки истёк',
  exhausted: 'Лимит по этой ссылке исчерпан',
  revoked: 'Ссылка отозвана владельцем',
  fulfilled: 'Файлы уже отправлены — ссылка закрыта',
  missing: 'Файл или папка по ссылке удалены',
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// Ссылка не даёт больше, чем может её автор прямо сейчас: автор удалён или потерял
// доступ к папке (файлу) — ссылка перестаёт действовать.
function ownerAllows(s) {
  const owner = getUser(s.createdBy);
  if (!owner) return null;
  if (s.type === 'file') {
    const ref = parseRef(s.key);
    return ref && acl.canRead(owner, folderFromKey(ref.rel)) ? owner : null;
  }
  if (s.type === 'upload') return acl.canWrite(owner, s.folder) ? owner : null;
  return acl.canRead(owner, s.folder) ? owner : null;
}

function stateOf(s) {
  const state = shares.stateOf(s);
  return state === 'active' && !ownerAllows(s) ? 'revoked' : state;
}

/** Ссылка, доступная прямо сейчас (иначе — понятная ошибка). */
function activeShare(req, { needUnlock = true, type } = {}) {
  const s = shares.get(req.params.id);
  if (!s) throw new HttpError(404, 'Ссылка не найдена');
  const state = stateOf(s);
  if (state !== 'active') throw new HttpError(410, STATE_TEXT[state]);
  if (type && !type.includes(s.type)) throw new HttpError(400, 'Это действие недоступно по этой ссылке');
  if (needUnlock && !shares.isUnlocked(s, readCookie(req, shares.unlockCookieName(s.id)))) throw new HttpError(401, 'Нужен пароль');
  return s;
}

// Ключ гостя должен лежать в папке ссылки (для «загрузить мне» — ровно в ней).
function keyInside(s, key, { exact = false } = {}) {
  const ref = parseRef(key);
  if (!ref) throw new HttpError(400, 'Некорректный ключ файла');
  const folder = folderFromKey(ref.rel);
  if (exact ? folder !== s.folder : !folder.startsWith(s.folder)) throw new HttpError(403, 'Файл не относится к этой ссылке');
  return ref;
}

// GET /api/public/s/:id — что за ссылка
publicSharesRouter.get('/:id', async (req, res) => {
  const s = shares.get(req.params.id);
  if (!s) throw new HttpError(404, 'Ссылка не найдена');
  const state = stateOf(s);
  const base = { id: s.id, type: s.type, state, message: STATE_TEXT[state] ?? null, owner: s.createdBy, expiresAt: s.expiresAt };
  if (state !== 'active') return res.status(410).json(base);
  const unlocked = shares.isUnlocked(s, readCookie(req, shares.unlockCookieName(s.id)));
  const info = { ...base, needsPassword: Boolean(s.passwordHash), unlocked, name: unlocked ? s.name : null, caption: s.caption ?? null, request: Boolean(s.request) };
  if (unlocked && s.type === 'file') {
    const { st, rel } = storages.resolveRef(s.key);
    const head = await st.headObject(rel);
    if (!head) { shares.fileGone(s.key); throw new HttpError(410, STATE_TEXT.missing); }
    info.file = { name: nameFromKey(rel), size: head.ContentLength ?? 0, lastModified: head.LastModified };
    info.downloadsLeft = s.maxDownloads ? s.maxDownloads - s.downloads : null;
  }
  if (unlocked && s.type === 'upload') {
    info.maxFileSize = Math.min(config.limits.maxFileSize, (s.maxFileSizeMb ?? Infinity) * MB);
    info.uploadsLeft = s.maxUploads ? s.maxUploads - s.uploads : null;
  }
  if (unlocked) info.hasDownloadLimit = Boolean(s.maxDownloads); // тогда без предпросмотра
  if (unlocked) shares.touch(s);
  res.json(info);
});

// POST /api/public/s/:id/unlock {password}
publicSharesRouter.post('/:id/unlock', unlockLimiter, async (req, res) => {
  const s = activeShare(req, { needUnlock: false });
  const cookie = await shares.unlock(s, req.body?.password);
  if (!cookie) throw new HttpError(403, 'Неверный пароль');
  res.cookie(shares.unlockCookieName(s.id), cookie.value, { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/', maxAge: cookie.maxAge });
  res.json({ ok: true });
});

// GET /api/public/s/:id/list?folder=sub/&cursor= — содержимое папки ссылки
publicSharesRouter.get('/:id/list', async (req, res) => {
  const s = activeShare(req, { type: ['folder'] });
  const sub = req.query.folder ?? '';
  if (!isValidFolder(sub) || !isValidFolder(s.folder + sub)) throw new HttpError(400, 'Некорректный путь папки');
  // Вложенные папки со своими правилами — по правам автора ссылки, как он сам видит их на сайте.
  const owner = ownerAllows(s);
  if (!acl.canSee(owner, s.folder + sub)) throw new HttpError(404, 'Папка не найдена');
  const result = await storages.listFolder(s.folder + sub, { cursor: req.query.cursor || undefined });
  const strip = (p) => p.slice(s.folder.length);
  const filesVisible = acl.canRead(owner, s.folder + sub);
  res.json({
    folder: sub,
    folders: result.folders.filter((f) => acl.canSee(owner, f.path)).map((f) => ({ path: strip(f.path), name: f.name })),
    files: filesVisible ? result.files.map(({ key, name, size, lastModified }) => ({ key, name, size, lastModified })) : [],
    nextCursor: result.nextCursor,
  });
});

// POST /api/public/s/:id/download {key?} — короткая ссылка на скачивание (10 мин)
publicSharesRouter.post('/:id/download', async (req, res) => {
  const s = activeShare(req, { type: ['file', 'folder'] });
  const key = s.type === 'file' ? s.key : req.body?.key;
  const ref = s.type === 'file' ? parseRef(key) : keyInside(s, key);
  if (s.type === 'folder' && !acl.canRead(ownerAllows(s), folderFromKey(ref.rel))) throw new HttpError(404, 'Файл не найден');
  const st = storages.get(ref.storageId);
  if (!(await st.headObject(ref.rel))) {
    if (s.type === 'file') shares.fileGone(s.key);
    throw new HttpError(404, 'Файл не найден');
  }
  if (s.type === 'folder') shares.touchFile(s, formatRef(ref.storageId, ref.rel));
  else shares.touch(s, 'downloads');
  audit(req, 'share.download', { id: s.id, name: nameFromKey(ref.rel) });
  res.json({ url: await st.presignGet(ref.rel, DOWNLOAD_TTL) });
});

// POST /api/public/s/:id/preview {key?} → {kind, url} — посмотреть файл в браузере, не скачивая.
// Не считается скачиванием, поэтому у ссылки с лимитом скачиваний предпросмотра нет.
const PREVIEW_MAX = { text: 1024 * 1024 };
publicSharesRouter.post('/:id/preview', async (req, res) => {
  const s = activeShare(req, { type: ['file', 'folder'] });
  if (s.maxDownloads) throw new HttpError(403, 'У этой ссылки ограничено число скачиваний — файл можно только скачать');
  const ref = s.type === 'file' ? parseRef(s.key) : keyInside(s, req.body?.key);
  if (s.type === 'folder' && !acl.canRead(ownerAllows(s), folderFromKey(ref.rel))) throw new HttpError(404, 'Файл не найден');
  const pk = previewKind(nameFromKey(ref.rel));
  if (!pk) throw new HttpError(415, 'Этот файл нельзя посмотреть в браузере');
  const st = storages.get(ref.storageId);
  const head = st && await st.headObject(ref.rel);
  if (!head) throw new HttpError(404, 'Файл не найден');
  if (PREVIEW_MAX[pk.kind] && (head.ContentLength ?? 0) > PREVIEW_MAX[pk.kind]) throw new HttpError(413, 'Файл слишком большой для просмотра');
  shares.touch(s);
  res.json({ kind: pk.kind, url: await st.presignGet(ref.rel, DOWNLOAD_TTL, { inline: true, contentType: pk.contentType }) });
});

// ---------- «загрузить мне» ----------
publicSharesRouter.post('/:id/upload', async (req, res) => {
  const s = activeShare(req, { type: ['upload'] });
  const maxSize = Math.min(config.limits.maxFileSize, (s.maxFileSizeMb ?? Infinity) * MB);
  const { name, size, type } = req.body ?? {};
  res.json(await wrap(() => uploadFlow.planUpload({ name, size, type, folder: s.folder, maxSize })));
});

publicSharesRouter.post('/:id/upload/parts', async (req, res) => {
  const s = activeShare(req, { type: ['upload'] });
  keyInside(s, req.body?.key, { exact: true });
  const uploadId = String(req.body?.uploadId ?? '');
  if (!uploadId || uploadId.length > 1024) throw new HttpError(400, 'Некорректный uploadId');
  res.json({ urls: await wrap(() => uploadFlow.presignParts(req.body?.key, uploadId, req.body?.partNumbers)) });
});

publicSharesRouter.post('/:id/upload/complete', async (req, res) => {
  const s = activeShare(req, { type: ['upload'] });
  keyInside(s, req.body?.key, { exact: true });
  const maxSize = Math.min(config.limits.maxFileSize, (s.maxFileSizeMb ?? Infinity) * MB);
  const uploadId = req.body?.uploadId === undefined ? undefined : String(req.body.uploadId);
  const { file, st, rel, size } = await wrap(() => uploadFlow.completeUpload(req.body?.key, uploadId, { maxSize }));
  // «Кто» — имя, которое гость сам указал на странице (необязательно).
  // eslint-disable-next-line no-control-regex
  const from = typeof req.body?.from === 'string' ? req.body.from.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';
  shares.noteUpload(s, { name: file.name, size, ip: req.ip, from });
  audit(req, 'share.upload', { id: s.id, storage: st.id, key: rel, size, from: from || undefined });
  res.json({ file: { name: file.name, size: file.size } });
});

// POST /api/public/s/:id/finish — «Готово» на запросе файла: ссылка закрывается.
publicSharesRouter.post('/:id/finish', (req, res) => {
  const s = activeShare(req, { type: ['upload'] });
  if (!s.request) throw new HttpError(400, 'Это действие только для запроса файла');
  if (!s.uploads) throw new HttpError(400, 'Сначала загрузите файлы');
  shares.fulfil(s);
  audit(req, 'share.fulfil', { id: s.id });
  res.json({ ok: true });
});

publicSharesRouter.post('/:id/upload/abort', async (req, res) => {
  const s = activeShare(req, { type: ['upload'] });
  keyInside(s, req.body?.key, { exact: true });
  await uploadFlow.abortUpload(req.body?.key, String(req.body?.uploadId ?? ''));
  res.json({ ok: true });
});
