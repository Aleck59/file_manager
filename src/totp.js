// Двухфакторная аутентификация: одноразовые коды TOTP (RFC 6238) — Google Authenticator,
// Яндекс Ключ, Aegis, 1Password и т. п. Плюс 10 одноразовых кодов восстановления.
//
// Секрет хранится в data/users.json (файл 0600, как и хеши паролей). Коды восстановления —
// только хешами. Повтор одного и того же кода запрещён (запоминаем последний шаг времени).
import crypto from 'node:crypto';
import { config } from './config.js';

const STEP = 30;
const DIGITS = 6;
const WINDOW = 1; // ±30 с на расхождение часов телефона
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(str) {
  const clean = str.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', fromBase32(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

export function newSecret() {
  return base32(crypto.randomBytes(20));
}

/** Ссылка otpauth:// — её кодирует QR для приложения-аутентификатора. */
export function otpauthUri(secret, username) {
  const issuer = config.appName || 'Файлообменник';
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

/**
 * Проверка кода. @returns {number|null} шаг времени совпавшего кода (сохраните как lastStep) или null.
 * lastStep — шаг последнего принятого кода: тот же код и более ранние не принимаются.
 */
export function verify(secret, code, lastStep = -1, now = Date.now()) {
  const digits = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const current = stepAt(now);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = current + d;
    if (step <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(digits))) return step;
  }
  return null;
}

// ---------- коды восстановления ----------
const hashCode = (code) => crypto.createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('base64url');

/** @returns {{ codes: string[], hashes: string[] }} — codes показываются один раз */
export function recoveryCodes(n = 10) {
  const codes = Array.from({ length: n }, () => {
    const raw = base32(crypto.randomBytes(5)).toLowerCase().slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}

/** @returns {string[]|null} оставшиеся хеши, если код подошёл (он сгорает), иначе null */
export function useRecoveryCode(hashes, code) {
  if (typeof code !== 'string' || !/^[a-z2-7]{4}-?[a-z2-7]{4}$/i.test(code.trim())) return null;
  const h = hashCode(code.trim());
  const i = (hashes ?? []).indexOf(h);
  return i < 0 ? null : hashes.filter((_, j) => j !== i);
}

// ---------- «билет» второго шага входа ----------
// После верного пароля выдаём подписанный билет на 5 минут: второй шаг принимает код только
// вместе с ним. В подпись входит хеш пароля — смена пароля обесценивает выданные билеты.
const TICKET_TTL = 5 * 60;
const ticketSig = (user, exp, via) => crypto.createHmac('sha256', config.auth.sessionSecret)
  .update(`2fa|${user.username}|${exp}|${via}|${user.passwordHash}`).digest('base64url');

export function issueTicket(user, via = 'password') {
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL;
  return `${Buffer.from(user.username).toString('base64url')}.${exp}.${via}.${ticketSig(user, exp, via)}`;
}

/** @param {(name: string) => object|null} getUser @returns {{user, via}|null} */
export function readTicket(ticket, getUser) {
  if (typeof ticket !== 'string' || ticket.length > 300) return null;
  const [name, exp, via, sig] = ticket.split('.');
  if (!sig || !(Number(exp) > Date.now() / 1000)) return null;
  const user = getUser(Buffer.from(name, 'base64url').toString());
  if (!user?.totp) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(ticketSig(user, exp, via));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { user, via } : null;
}
