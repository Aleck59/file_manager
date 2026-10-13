// Разделы только для администратора: журнал действий, права на папки.
import * as auditLog from '../audit-log.js';
import { Router } from '../http.js';
import * as acl from '../acl.js';
import { isValidFolder } from '../keys.js';
import { audit, HttpError } from '../middleware/security.js';
import { getUser, listUsers } from '../users.js';

export const adminRouter = Router();

// GET /api/admin/audit?limit&before&user&action&q — записи журнала, новые сверху
adminRouter.get('/audit', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const str = (v, max = 200) => {
    if (v === undefined || v === '') return undefined;
    if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'Некорректный фильтр');
    return v;
  };
  res.json(auditLog.list({ limit, before: str(req.query.before, 40), user: str(req.query.user, 64), action: str(req.query.action, 40), q: str(req.query.q) }));
});

// ---------- права на папки ----------
// GET /api/admin/acl?folder= → правило папки (своё или унаследованное) и пользователи
adminRouter.get('/acl', (req, res) => {
  const folder = typeof req.query.folder === 'string' ? req.query.folder : '';
  if (!folder || !isValidFolder(folder)) throw new HttpError(400, 'Некорректный путь папки');
  res.json({ ...acl.getRule(folder), users: listUsers().map(({ username, role }) => ({ username, role })), rules: acl.listRules() });
});

// PUT /api/admin/acl {folder, rule: {users: {логин: none|read|write}, others: none|read|role} | null}
adminRouter.put('/acl', (req, res) => {
  const folder = req.body?.folder;
  if (typeof folder !== 'string' || !folder || !isValidFolder(folder)) throw new HttpError(400, 'Некорректный путь папки');
  const rule = req.body?.rule ?? null;
  if (rule !== null) {
    if (typeof rule !== 'object' || typeof (rule.users ?? {}) !== 'object') throw new HttpError(400, 'Некорректное правило');
    for (const [u, level] of Object.entries(rule.users ?? {})) {
      if (!getUser(u)) throw new HttpError(400, `Нет пользователя «${u}»`);
      if (!['none', 'read', 'write'].includes(level)) throw new HttpError(400, 'Уровень доступа: none, read или write');
    }
    if (!['none', 'read', 'role'].includes(rule.others)) throw new HttpError(400, 'Остальным: none, read или role');
  }
  acl.setRule(folder, rule);
  audit(req, 'acl.set', { folder, rule });
  res.json({ ok: true, ...acl.getRule(folder) });
});
