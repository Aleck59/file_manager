// scrypt-хеширование пароля. Модуль не зависит от config, поэтому используется
// и сервером, и CLI-скриптом `npm run hash-password`.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const N = 16384, r = 8, p = 1; // ~16 МБ памяти на вычисление
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt' || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}
