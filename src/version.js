// Версия для «Настроек» и /healthz: номер из package.json и коммит git (читаем файлы .git
// напрямую — без запуска git). Помогает убедиться, что обновление на сервере применилось.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function commit() {
  try {
    const git = path.join(config.root, '.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return { sha: head.slice(0, 7), branch: null };
    const ref = head.slice(5);
    let sha = '';
    try { sha = fs.readFileSync(path.join(git, ref), 'utf8').trim(); } catch {
      const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8');
      sha = packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] ?? '';
    }
    return { sha: sha.slice(0, 7), branch: ref.replace('refs/heads/', '') };
  } catch {
    return { sha: null, branch: null };
  }
}

let pkg = '0.0.0';
try { pkg = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version; } catch { /* нет package.json */ }

export const version = { version: pkg, ...commit(), startedAt: new Date().toISOString() };
