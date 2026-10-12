#!/usr/bin/env node
// Генерирует scrypt-хеш пароля для ADMIN_PASSWORD_HASH.
// Использование: npm run hash-password   (пароль вводится скрыто)
import { hashPassword } from '../src/password.js';

function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => (data += c));
      stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const password = await readHidden('Новый пароль администратора: ');
if (password.length < 10) {
  console.error('Пароль должен быть не короче 10 символов.');
  process.exit(1);
}
console.log('\nДобавьте в .env строку (в одинарных кавычках!):\n');
console.log(`ADMIN_PASSWORD_HASH='${await hashPassword(password)}'`);
