// Разделы только для администратора: журнал действий.
import * as auditLog from '../audit-log.js';
import { Router } from '../http.js';
import { HttpError } from '../middleware/security.js';

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
