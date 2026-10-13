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

// Наружу — без хешей и секретов 2FA.
export const publicUser = ({ username, role, createdAt, email, quotaMb, totp, personal }) => ({
  username, role, createdAt, email: email ?? null, quotaMb: quotaMb ?? 0, twoFactor: Boolean(totp), personal: Boolean(personal),
});

/** Пользователь по почте (вход через Яндекс/Google): почту указывает администратор. */
export function findByEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return null;
  return [...users.values()].find((u) => u.email && u.email.toLowerCase() === e) ?? null;
}

export function getUser(username) {
  return users.get(String(username ?? '').toLowerCase()) ?? null;
}

export function listUsers() {
  // Простое сравнение: логины — латиница, а localeCompare на сервере подгружает данные ICU (~5 МБ).
  return [...users.values()].map(publicUser).sort((a, b) => (a.username < b.username ? -1 : 1));
}

export function normalizeUsername(input) {
  const name = String(input ?? '').trim().toLowerCase();
  return USERNAME_RE.test(name) ? name : null;
}

const adminCount = () => [...users.values()].filter((u) => u.role === 'admin').length;

export function createUser({ username, role, passwordHash, email, quotaMb, personal }) {
  if (users.has(username)) return { error: 'Пользователь с таким логином уже существует' };
  if (email && findByEmail(email)) return { error: 'Эта почта уже указана у другого пользователя' };
  const user = { username, role, passwordHash, createdAt: new Date().toISOString(), ...(email && { email }), ...(quotaMb && { quotaMb }), ...(personal && { personal: true }) };
  users.set(username, user);
  persist();
  return { user: publicUser(user) };
}

// Изменяемые поля. undefined — не менять; null — убрать (почта, 2FA).
const MUTABLE = ['role', 'passwordHash', 'email', 'quotaMb', 'totp', 'totpPending', 'personal'];

export function updateUser(username, changes) {
  const user = users.get(username);
  if (!user) return { error: 'Пользователь не найден', status: 404 };
  const { role, email } = changes;
  if (role && role !== 'admin' && user.role === 'admin' && adminCount() === 1) {
    return { error: 'Нельзя понизить единственного администратора' };
  }
  if (email && findByEmail(email) && findByEmail(email).username !== username) {
    return { error: 'Эта почта уже указана у другого пользователя' };
  }
  const next = { ...user };
  for (const key of MUTABLE) {
    if (changes[key] === undefined) continue;
    if (changes[key] === null || changes[key] === '') delete next[key];
    else next[key] = changes[key];
  }
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
