// Корзина: список, восстановление, удаление навсегда («Редактор» и выше; очистить всю — администратор).
import * as acl from '../acl.js';
import { hasRole, requireRole } from '../auth.js';
import { config } from '../config.js';
import { Router } from '../http.js';
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

// GET /api/trash
// Видно только удалённое из папок, к которым есть доступ.
trashRouter.get('/', (req, res) => {
  res.json({ days: config.limits.trashDays, items: trash.list().filter((b) => acl.canRead(req.user, b.folder)) });
});

// Вернуть или стереть можно только то, что лежало в папке с правом записи.
function allowed(req) {
  const b = trash.get(req.body?.id);
  if (!b || !acl.canRead(req.user, b.folder)) throw new HttpError(404, 'В корзине такого нет');
  if (!(b.kind === 'folder' ? acl.canWriteTree(req.user, b.folder) : acl.canWrite(req.user, b.folder))) {
    throw new HttpError(403, 'Нет прав на эту папку');
  }
}

// POST /api/trash/restore {id}
trashRouter.post('/restore', async (req, res) => {
  allowed(req);
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
