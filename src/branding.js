// Название и логотип файлообменника (Настройки → Сайт). Логотип — data/logo.<ext>.
// Принимаются только растровые PNG/JPEG/WebP, тип проверяется по сигнатуре файла:
// SVG не допускается (в нём может быть скрипт), чужое расширение не поможет.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const MAX_LOGO = 256 * 1024;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function detect(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const fileFor = (ext) => path.join(config.dataDir, `logo.${ext}`);

export function currentLogo() {
  for (const ext of Object.keys(TYPES)) {
    try {
      const st = fs.statSync(fileFor(ext));
      return { file: fileFor(ext), type: TYPES[ext], version: Math.floor(st.mtimeMs) };
    } catch { /* нет такого */ }
  }
  return null;
}

export function saveLogo(buf) {
  if (!buf?.length) throw Object.assign(new Error('Пустой файл'), { status: 400 });
  if (buf.length > MAX_LOGO) throw Object.assign(new Error('Логотип больше 256 КБ'), { status: 413 });
  const ext = detect(buf);
  if (!ext) throw Object.assign(new Error('Логотип должен быть PNG, JPEG или WebP'), { status: 400 });
  removeLogo();
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(fileFor(ext), buf, { mode: 0o600 });
}

export function removeLogo() {
  for (const ext of Object.keys(TYPES)) fs.rmSync(fileFor(ext), { force: true });
}

export function branding() {
  const logo = currentLogo();
  return { name: config.appName, logo: logo ? `/branding/logo?v=${logo.version}` : null };
}
