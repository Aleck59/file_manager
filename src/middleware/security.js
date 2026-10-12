import helmet from 'helmet';
import { config } from '../config.js';

// Origin-ы S3, к которым браузеру разрешено обращаться (CSP connect-src).
// Покрываем и path-style (endpoint/bucket), и virtual-hosted-style (bucket.endpoint).
function s3Origins() {
  const url = new URL(config.s3.endpoint);
  return [url.origin, `${url.protocol}//${config.s3.bucket}.${url.host}`];
}

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'", ...s3Origins()],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
      ...(config.secureCookies ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  // HSTS лучше включать в Nginx/FastPanel после проверки HTTPS; здесь — консервативно.
  strictTransportSecurity: config.secureCookies ? { maxAge: 15552000 } : false,
  referrerPolicy: { policy: 'no-referrer' },
});

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
