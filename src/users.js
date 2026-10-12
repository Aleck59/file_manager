// Хранилище пользователей: небольшой JSON-файл (data/users.json) + копия в памяти.
// Для файлообменника на десятки пользователей БД не нужна, а ОЗУ экономится.
// Запись атомарная (tmp + rename), чтобы файл не повредился при сбое.
//
// Роли: viewer — просмотр и скачивание; editor — + загрузка, папки, удаление;
//       admin — + управление пользователями и сведения о хранилище.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const ROLES = ['viewer', 'editor', 'admin'];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const file = path.join(config.dataDir, 'users.json');

let users = new Map();

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users: [...users.values()] }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function initUsers() {
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    users = new Map(data.users.map((u) => [u.username, u]));
    if (![...users.values()].some((u) => u.role === 'admin')) {
      throw new Error(`В ${file} нет ни одного администратора. Удалите файл, чтобы пересоздать его из .env`);
    }
    return;
  }
  const { bootstrapUsername, bootstrapPasswordHash } = config.auth;
  if (!bootstrapPasswordHash) {
    throw new Error('Первый запуск: задайте ADMIN_PASSWORD_HASH в .env (npm run hash-password)');
  }
  if (!USERNAME_RE.test(bootstrapUsername)) throw new Error('Некорректный ADMIN_USERNAME');
  users.set(bootstrapUsername, {
    username: bootstrapUsername,
    role: 'admin',
    passwordHash: bootstrapPasswordHash,
    createdAt: new Date().toISOString(),
  });
  persist();
  console.log(`Создан администратор "${bootstrapUsername}" (${file})`);
}

export const publicUser = ({ username, role, createdAt }) => ({ username, role, createdAt });

export function getUser(username) {
  return users.get(String(username ?? '').toLowerCase()) ?? null;
}

export function listUsers() {
  return [...users.values()].map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
}

export function normalizeUsername(input) {
  const name = String(input ?? '').trim().toLowerCase();
  return USERNAME_RE.test(name) ? name : null;
}

const adminCount = () => [...users.values()].filter((u) => u.role === 'admin').length;

export function createUser({ username, role, passwordHash }) {
  if (users.has(username)) return { error: 'Пользователь с таким логином уже существует' };
  const user = { username, role, passwordHash, createdAt: new Date().toISOString() };
  users.set(username, user);
  persist();
  return { user: publicUser(user) };
}

export function updateUser(username, { role, passwordHash }) {
  const user = users.get(username);
  if (!user) return { error: 'Пользователь не найден', status: 404 };
  if (role && role !== 'admin' && user.role === 'admin' && adminCount() === 1) {
    return { error: 'Нельзя понизить единственного администратора' };
  }
  const next = { ...user, ...(role && { role }), ...(passwordHash && { passwordHash }) };
  users.set(username, next);
  persist();
  return { user: publicUser(next) };
}

export function deleteUser(username) {
  const user = users.get(username);
  if (!user) return { error: 'Пользователь не найден', status: 404 };
  if (user.role === 'admin' && adminCount() === 1) return { error: 'Нельзя удалить единственного администратора' };
  users.delete(username);
  persist();
  return { ok: true };
}

export const countUsers = () => users.size;
