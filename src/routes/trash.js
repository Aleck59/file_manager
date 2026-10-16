// Корзина: список, восстановление, удаление навсегда («Редактор» и выше; очистить всю — администратор).
import * as acl from '../acl.js';
import { hasRole, requireRole } from '../auth.js';
import { config } from '../config.js';
import { Router } from '../http.js';
import { folderFromKey } from '../keys.js';
import { audit, HttpError } from '../middleware/security.js';
import * as sharesStore from '../shares.js';
import * as storages from '../storages.js';
import * as trash from '../trash.js';

export const trashRouter = Router();
trashRouter.use(requireRole('editor'));

const wrap = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof HttpError || !err.status ? err : new HttpError(err.status, err.message);
  }
};
const publicWarnings = (req, warnings = []) => (hasRole(req.user, 'admin') ? warnings
  : warnings.map((w) => ({ storage: w.storage, error: 'нет связи с хранилищем' })));

// Папки, из которых удалены файлы записи: у записи «N файлов» они могут быть разными,
// и права проверяются по каждой, а не по папке первого файла.
const foldersOf = (b) => (b.kind === 'folder' ? [b.folder]
  : [...new Set((b.keys ?? [b.key]).map((k) => folderFromKey(k.slice(k.indexOf(':') + 1))))]);

// GET /api/trash
// Видно только удалённое из папок, к которым есть доступ.
trashRouter.get('/', (req, res) => {
  res.json({ days: config.limits.trashDays, items: trash.list().filter((b) => foldersOf(b).every((f) => acl.canRead(req.user, f))) });
});

// Вернуть или стереть можно только то, что лежало в папке с правом записи
// (один файл из записи — по его папке, всю запись — по всем её папкам).
function allowed(req) {
  const b = trash.get(req.body?.id);
  if (!b) throw new HttpError(404, 'В корзине такого нет');
  const one = req.body?.key !== undefined && (b.keys ?? []).includes(req.body.key);
  const folders = one ? [folderFromKey(req.body.key.slice(req.body.key.indexOf(':') + 1))] : foldersOf(b);
  if (!folders.every((f) => acl.canRead(req.user, f))) throw new HttpError(404, 'В корзине такого нет');
  if (!folders.every((f) => (b.kind === 'folder' ? acl.canWriteTree(req.user, f) : acl.canWrite(req.user, f)))) {
    throw new HttpError(403, 'Нет прав на эту папку');
  }
}

// POST /api/trash/restore {id}
trashRouter.post('/restore', async (req, res) => {
  allowed(req);
  // {id, key} — вернуть один файл из записи «N файлов»
  if (req.body?.key !== undefined) {
    const { key } = await wrap(() => trash.takeOut(req.body.id, req.body.key, { restore: true }));
    storages.invalidateStats();
    sharesStore.fileBack(key);
    audit(req, 'trash.restore', { id: req.body.id, key });
    return res.json({ ok: true, key });
  }
  const { entry, warnings } = await wrap(() => trash.restore(req.body?.id));
  storages.invalidateStats();
  if (entry.kind === 'folder') sharesStore.folderBack(entry.folder);
  else for (const key of entry.keys ?? [entry.key]) sharesStore.fileBack(key);
  audit(req, 'trash.restore', { id: entry.id, kind: entry.kind, name: entry.name, folder: entry.folder });
  res.json({ ok: true, item: entry, warnings: publicWarnings(req, warnings) });
});

// POST /api/trash/delete {id} — навсегда
trashRouter.post('/delete', async (req, res) => {
  allowed(req);
  if (req.body?.key !== undefined) {
    const { key } = await wrap(() => trash.takeOut(req.body.id, req.body.key, { restore: false }));
    storages.invalidateStats();
    audit(req, 'trash.delete', { id: req.body.id, key });
    return res.json({ ok: true });
  }
  const { entry, warnings } = await wrap(() => trash.purge(req.body?.id));
  storages.invalidateStats();
  audit(req, 'trash.delete', { id: entry.id, kind: entry.kind, name: entry.name, folder: entry.folder });
  res.json({ ok: true, warnings: publicWarnings(req, warnings) });
});

// POST /api/trash/empty
trashRouter.post('/empty', requireRole('admin'), async (req, res) => {
  const { deleted, warnings } = await wrap(() => trash.empty());
  storages.invalidateStats();
  audit(req, 'trash.empty', { deleted });
  res.json({ ok: true, deleted, warnings: publicWarnings(req, warnings) });
});
