// Права на папки и личные папки.
//
// Без правил всё как раньше: доступ определяет роль (viewer — чтение, editor — запись,
// admin — всё). Правило на папку действует на неё и всё внутри (пока ниже нет своего):
//   users   — {логин: 'none' | 'read' | 'write'} — доступ отдельных пользователей;
//   others  — остальным: 'none' (папка скрыта), 'read' (только просмотр) или 'role' (по роли).
// Права не превышают роль: зритель с «write» в правиле всё равно только читает.
// Администраторы видят и могут всё.
//
// Папка с запретом скрыта из списков, поиска, статистики. Если внутри неё есть подпапка,
// доступная пользователю, сама папка видна ему «проходом» — без своих файлов.
//
// Личные папки: «<PERSONAL_ROOT>/<логин>/» с правилом {users: {логин: write}, others: none}.
// Хранение — data/acl.json (0600).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const LEVELS = ['none', 'read', 'write'];
const file = () => path.join(config.dataDir, 'acl.json');
let rules = {}; // путь → {users, others, personal?}

try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (data && typeof data.rules === 'object') rules = data.rules;
} catch { /* правил ещё нет */ }

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ rules }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

const min = (a, b) => LEVELS[Math.min(LEVELS.indexOf(a), LEVELS.indexOf(b))];
const roleLevel = (user) => (user.role === 'admin' || user.role === 'editor' ? 'write' : 'read');
export const isAdmin = (user) => user?.role === 'admin';

/** Ближайшее правило для папки (сама папка или ближайший предок). */
function ruleFor(folder) {
  let best = null;
  for (const p of Object.keys(rules)) if (folder.startsWith(p) && (!best || p.length > best.length)) best = p;
  return best ? { path: best, ...rules[best] } : null;
}

/** Уровень доступа к папке: 'none' | 'read' | 'write'. */
export function access(user, folder) {
  if (!user) return 'none';
  if (isAdmin(user)) return 'write';
  const max = roleLevel(user);
  const rule = ruleFor(folder);
  if (!rule) return max;
  const own = rule.users?.[user.username];
  if (own) return min(own, max);
  return rule.others === 'role' ? max : rule.others === 'read' ? min('read', max) : 'none';
}

export const canRead = (user, folder) => access(user, folder) !== 'none';
export const canWrite = (user, folder) => access(user, folder) === 'write';

/** Видна ли папка в списке: доступна сама или ведёт к доступной подпапке. */
export function canSee(user, folder) {
  if (canRead(user, folder)) return true;
  return Object.keys(rules).some((p) => p.startsWith(folder) && p !== folder && canRead(user, p));
}

/** Запись в папку и во все вложенные папки со своими правилами (удаление, перемещение). */
export function canWriteTree(user, folder) {
  if (!canWrite(user, folder)) return false;
  return Object.keys(rules).every((p) => !p.startsWith(folder) || canWrite(user, p));
}

/** Это сама личная папка какого-то пользователя (её не удаляют и не перемещают). */
export const isPersonalRoot = (folder) => Boolean(rules[folder]?.personal);

/** Есть ли вообще ограничения (быстрый путь: без правил ничего не фильтруем). */
export const hasRules = () => Object.keys(rules).length > 0;

// ---------- правила ----------
export function getRule(folder) {
  const own = rules[folder] ? { path: folder, ...rules[folder] } : null;
  const inherited = own ? null : ruleFor(folder);
  return { own, inherited };
}

/** @param {{users: Record<string,string>, others: 'none'|'read'|'role'} | null} rule */
export function setRule(folder, rule) {
  if (rule === null) delete rules[folder];
  else {
    const users = {};
    for (const [u, level] of Object.entries(rule.users ?? {})) if (LEVELS.includes(level)) users[u] = level;
    rules[folder] = { users, others: ['none', 'read', 'role'].includes(rule.others) ? rule.others : 'none', ...(rules[folder]?.personal && { personal: rules[folder].personal }) };
  }
  persist();
}

export function listRules() {
  return Object.entries(rules).map(([p, r]) => ({ path: p, ...r })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Папку переименовали/переместили — правила её и подпапок едут следом. */
export function refolder(oldPath, newPath) {
  let changed = false;
  for (const p of Object.keys(rules)) {
    if (!p.startsWith(oldPath)) continue;
    rules[newPath + p.slice(oldPath.length)] = rules[p];
    delete rules[p];
    changed = true;
  }
  if (changed) persist();
}

export function forgetFolder(prefix) {
  let changed = false;
  for (const p of Object.keys(rules)) if (p.startsWith(prefix) && !rules[p].personal) { delete rules[p]; changed = true; }
  if (changed) persist();
}

export function forgetUser(username) {
  let changed = false;
  for (const r of Object.values(rules)) if (r.users?.[username]) { delete r.users[username]; changed = true; }
  if (changed) persist();
}

// ---------- личные папки ----------
export const personalPath = (username) => `${config.personal.root}/${username}/`;

/** Есть ли у пользователя личная папка: для всех (настройка) или только для него (в профиле). */
export const hasPersonal = (user) => Boolean(user && (config.personal.enabled || user.personal));

/** Создаёт правило личной папки (если включены). @returns {string|null} путь, если правило новое */
export function ensurePersonal(user) {
  if (!hasPersonal(user)) return null;
  const p = personalPath(user.username);
  if (rules[p]) return null;
  rules[p] = { users: { [user.username]: 'write' }, others: 'none', personal: user.username };
  persist();
  return p;
}

/** Личная ли это папка пользователя (или внутри неё). */
export const inPersonal = (user, folder) => hasPersonal(user) && folder.startsWith(personalPath(user.username));
