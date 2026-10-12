import { config, onConfigChange } from '../config.js';

// Origin-ы S3, к которым браузеру разрешено обращаться (CSP connect-src и т.д.).
// Покрываем и path-style (endpoint/bucket), и virtual-hosted-style (bucket.endpoint).
function s3Origins() {
  if (!config.s3.endpoint) return [];
  const url = new URL(config.s3.endpoint);
  return [url.origin, ...(config.s3.bucket ? [`${url.protocol}//${config.s3.bucket}.${url.host}`] : [])];
}

// Заголовки безопасности (то, что раньше делал helmet, без лишней зависимости).
// Пересобираются, когда администратор меняет адрес сайта или хранилища.
let headers;
function buildHeaders() {
  const s3 = s3Origins().join(' ');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    // S3 — для предпросмотра изображений, видео/аудио и PDF по presigned-ссылкам.
    `img-src 'self' data: ${s3}`,
    `media-src 'self' ${s3}`,
    `frame-src ${s3 || "'none'"}`,
    "font-src 'self'",
    `connect-src 'self' ${s3}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    ...(config.secureCookies ? ['upgrade-insecure-requests'] : []),
  ].map((d) => d.trim()).join('; ');
  headers = {
    'Content-Security-Policy': csp,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
    'X-Frame-Options': 'DENY',
    'X-Permitted-Cross-Domain-Policies': 'none',
    // HSTS лучше включать в Nginx/FastPanel после проверки HTTPS; здесь — консервативно.
    ...(config.secureCookies ? { 'Strict-Transport-Security': 'max-age=15552000' } : {}),
  };
}
buildHeaders();
onConfigChange((changed) => {
  if (changed.some((k) => k === 'APP_ORIGIN' || k === 'S3_ENDPOINT' || k === 'S3_BUCKET')) buildHeaders();
});

export function securityHeaders(req, res, next) {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  next();
}

// CSRF-защита: изменяющие запросы принимаются только с нашего Origin.
// Вместе с SameSite=Strict cookie этого достаточно без CSRF-токенов.
export function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  if (origin === config.appOrigin || (!origin && fetchSite === 'same-origin')) return next();
  res.status(403).json({ error: 'Запрос с недопустимого источника' });
}

// Простой in-memory rate limiter (фиксированное окно). Для одного процесса
// на маленьком VDS этого достаточно и не требует Redis.
export function rateLimit({ windowMs, max, message = 'Слишком много запросов, попробуйте позже' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.reset <= now) hits.delete(ip);
  }, windowMs);
  timer.unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Единый обработчик ошибок: клиенту — понятное сообщение без внутренних деталей,
// в лог — полная информация.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.code === 'S3_NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });

  const s3Status = err.$metadata?.httpStatusCode;
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}:`, err.name, err.message);
  if (s3Status === 404 || err.name === 'NoSuchKey' || err.name === 'NoSuchUpload') {
    return res.status(404).json({ error: 'Объект не найден в хранилище' });
  }
  if (s3Status || err.$fault) {
    return res.status(502).json({ error: 'Ошибка при обращении к хранилищу S3' });
  }
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}
