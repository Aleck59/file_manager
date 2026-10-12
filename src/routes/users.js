// Управление пользователями (только для администратора).
import { Router } from '../http.js';
import { HttpError } from '../middleware/security.js';
import { hashPassword } from '../password.js';
import { createUser, deleteUser, listUsers, normalizeUsername, ROLES, updateUser } from '../users.js';
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

function unwrap(result) {
  if (result.error) throw new HttpError(result.status ?? 400, result.error);
  return result;
}

usersRouter.get('/', (req, res) => {
  res.json({ users: listUsers(), roles: ROLES });
});

usersRouter.post('/', async (req, res) => {
  const username = checkUsername(req.body?.username);
  const role = checkRole(req.body?.role);
  const passwordHash = await hashPassword(checkPassword(req.body?.password));
  res.status(201).json(unwrap(createUser({ username, role, passwordHash })));
});

usersRouter.patch('/:username', async (req, res) => {
  const username = checkUsername(req.params.username);
  const { role, password } = req.body ?? {};
  if (role === undefined && password === undefined) throw new HttpError(400, 'Нечего изменять');
  if (role !== undefined && username === req.user.username && role !== req.user.role) {
    throw new HttpError(400, 'Нельзя изменить собственную роль');
  }
  const changes = {
    ...(role !== undefined && { role: checkRole(role) }),
    ...(password !== undefined && { passwordHash: await hashPassword(checkPassword(password)) }),
  };
  res.json(unwrap(updateUser(username, changes)));
});

usersRouter.delete('/:username', (req, res) => {
  const username = checkUsername(req.params.username);
  if (username === req.user.username) throw new HttpError(400, 'Нельзя удалить самого себя');
  res.json(unwrap(deleteUser(username)));
});
