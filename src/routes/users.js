// Управление пользователями (только для администратора).
import * as acl from '../acl.js';
import { config } from '../config.js';
import * as storages from '../storages.js';
import { Router } from '../http.js';
import { audit, HttpError } from '../middleware/security.js';
import { hashPassword } from '../password.js';
import { createUser, deleteUser, getUser, listUsers, normalizeUsername, ROLES, updateUser } from '../users.js';
import { MIN_PASSWORD_LENGTH } from './auth.js';

export const usersRouter = Router();

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 256) {
    throw new HttpError(400, `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`);
  }
  return password;
}

function checkRole(role) {
  if (!ROLES.includes(role)) throw new HttpError(400, 'Некорректная роль');
  return role;
}

function checkUsername(input) {
  const username = normalizeUsername(input);
  if (!username) {
    throw new HttpError(400, 'Логин: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание');
  }
  return username;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
// Почта — для входа через Яндекс/Google; '' или null — убрать.
function checkEmail(email) {
  if (email === null || email === '') return null;
  const e = String(email).trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'Некорректная почта');
  return e;
}
// Квота личной папки в МБ; 0 — без ограничения.
function checkQuota(q) {
  const n = Number(q ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 100 * 1024 * 1024) throw new HttpError(400, 'Квота — целое число мегабайт (0 — без ограничения)');
  return n;
}

function unwrap(result) {
  if (result.error) throw new HttpError(result.status ?? 400, result.error);
  return result;
}

// Личная папка у пользователя: правило доступа и папка в хранилищах (сразу, не дожидаясь входа).
// Выключение не удаляет папку и её файлы — правило «только владелец» остаётся.
async function makePersonal(username) {
  const created = acl.ensurePersonal(getUser(username));
  if (created) await storages.createFolder(created).catch(() => {});
}

usersRouter.get('/', (req, res) => {
  const users = listUsers().map((u) => ({ ...u, personalPath: acl.hasPersonal(getUser(u.username)) ? acl.personalPath(u.username) : null }));
  res.json({ users, roles: ROLES, personalForAll: config.personal.enabled });
});

usersRouter.post('/', async (req, res) => {
  const username = checkUsername(req.body?.username);
  const role = checkRole(req.body?.role);
  const passwordHash = await hashPassword(checkPassword(req.body?.password));
  const email = req.body?.email ? checkEmail(req.body.email) : undefined;
  const quotaMb = req.body?.quotaMb ? checkQuota(req.body.quotaMb) : undefined;
  const personal = req.body?.personal === true;
  const result = unwrap(createUser({ username, role, passwordHash, email, quotaMb, personal }));
  await makePersonal(username);
  audit(req, 'user.create', { username, role, email, personal });
  res.status(201).json(result);
});

usersRouter.patch('/:username', async (req, res) => {
  const username = checkUsername(req.params.username);
  const { role, password, email, quotaMb, personal } = req.body ?? {};
  if (role === undefined && password === undefined && email === undefined && quotaMb === undefined && personal === undefined) throw new HttpError(400, 'Нечего изменять');
  if (role !== undefined && username === req.user.username && role !== req.user.role) {
    throw new HttpError(400, 'Нельзя изменить собственную роль');
  }
  const changes = {
    ...(role !== undefined && { role: checkRole(role) }),
    ...(password !== undefined && { passwordHash: await hashPassword(checkPassword(password)) }),
    ...(email !== undefined && { email: checkEmail(email) }),
    ...(quotaMb !== undefined && { quotaMb: checkQuota(quotaMb) || null }),
    ...(personal !== undefined && { personal: personal === true || null }),
  };
  const result = unwrap(updateUser(username, changes));
  if (personal === true) await makePersonal(username);
  audit(req, 'user.update', { username, role: changes.role, password: changes.passwordHash ? 'изменён' : undefined, email: changes.email, quotaMb: changes.quotaMb });
  res.json(result);
});

// POST /api/users/:username/2fa/reset — сбросить 2FA (пользователь потерял телефон и коды)
usersRouter.post('/:username/2fa/reset', (req, res) => {
  const username = checkUsername(req.params.username);
  unwrap(updateUser(username, { totp: null, totpPending: null }));
  audit(req, 'user.2fa', { username, enabled: false, by: 'admin' });
  res.json({ ok: true });
});

usersRouter.delete('/:username', (req, res) => {
  const username = checkUsername(req.params.username);
  if (username === req.user.username) throw new HttpError(400, 'Нельзя удалить самого себя');
  const result = unwrap(deleteUser(username));
  acl.forgetUser(username);
  audit(req, 'user.delete', { username });
  res.json(result);
});
