// Минимальный HTTP-слой с Express-совместимым API (Router, req.body, res.json, ...).
//
// Зачем: Express 5 со всем деревом зависимостей (qs, body-parser, send, router, iconv-lite…)
// занимает ~19 МБ ОЗУ — четверть потребления всего приложения. Здесь только то, что нужно
// файлообменнику, на чистом node:http, без внешних зависимостей. Обработчики пишутся так же,
// как для Express: (req, res, next), async-ошибки уходят в обработчик ошибок (err, req, res, next).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// node:http загружаем через require, а не через ESM-import: при ESM-импорте Node 22 строит
// «фасад» модуля и обращается ко всем его экспортам, включая ленивый http.WebSocket, — это
// подгружает встроенный undici (fetch/WebSocket) целиком, лишние ~5 МБ ОЗУ, и ломает
// запуск с --jitless (undici требует WebAssembly).
const http = createRequire(import.meta.url)('node:http');

// ---------- маршрутизация ----------

function compilePath(pattern) {
  const keys = [];
  const re = pattern.replace(/\/:(\w+)/g, (_, key) => { keys.push(key); return '/([^/]+)'; });
  return { re: new RegExp(`^${re}/?$`), keys };
}

function run(fn, args, next) {
  try {
    const out = fn(...args);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
}

export function Router() {
  const layers = [];

  function router(req, res, done) {
    let i = 0;
    const base = req.routePath;

    const next = (err) => {
      req.routePath = base;
      const layer = layers[i++];
      if (!layer) return done(err);
      const rel = req.routePath;

      if (layer.route) {
        if (err || (layer.method !== req.method && !(layer.method === 'GET' && req.method === 'HEAD'))) return next(err);
        const m = layer.route.re.exec(rel);
        if (!m) return next();
        req.params = Object.fromEntries(layer.route.keys.map((k, idx) => [k, safeDecode(m[idx + 1])]));
        let j = 0;
        const step = (e) => {
          if (e) return next(e);
          const fn = layer.fns[j++];
          if (!fn) return next();
          run(fn, [req, res, step], step);
        };
        return step();
      }

      // middleware / вложенный роутер, смонтированный на префикс
      if (layer.prefix !== '/' && rel !== layer.prefix && !rel.startsWith(`${layer.prefix}/`)) return next(err);
      const isErrorHandler = layer.fn.length === 4;
      if (Boolean(err) !== isErrorHandler) return next(err);
      if (layer.prefix !== '/') req.routePath = rel.slice(layer.prefix.length) || '/';
      if (isErrorHandler) run(layer.fn, [err, req, res, next], next);
      else run(layer.fn, [req, res, next], next);
    };
    next();
  }

  router.use = (...args) => {
    const prefix = typeof args[0] === 'string' ? args.shift().replace(/\/+$/, '') || '/' : '/';
    for (const fn of args.flat()) layers.push({ prefix, fn });
    return router;
  };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    router[method] = (pattern, ...fns) => {
      const route = compilePath(pattern);
      layers.push({ method: method.toUpperCase(), route, fns: fns.flat() });
      return router;
    };
  }
  return router;
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// ---------- тело запроса ----------

export class HttpBodyError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

export function json({ limit = 32 * 1024 } = {}) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return next();
    }
    if (Number(req.headers['content-length']) > limit) return next(new HttpBodyError('entity.too.large', 'too large'));
    // next() должен быть вызван ровно один раз: после req.destroy() может прийти ещё 'error'.
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      next(err);
    };
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(new HttpBodyError('entity.too.large', 'too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        req.body = text ? JSON.parse(text) : {};
      } catch {
        return finish(new HttpBodyError('entity.parse.failed', 'bad json'));
      }
      finish();
    });
    req.on('error', finish);
  };
}

// ---------- статические файлы ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function sendFile(req, res, file, { maxAge = 0, cacheControl } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.status(404).type('text/plain; charset=utf-8').send('Not found');
      return;
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    res.setHeader('Cache-Control', cacheControl ?? `public, max-age=${maxAge}`);
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

export function serveStatic(root, { maxAge = 0 } = {}) {
  const base = path.resolve(root);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const rel = safeDecode(req.path);
    // Скрытые файлы и выход за пределы каталога не отдаём.
    if (rel.includes('\0') || rel.split('/').some((seg) => seg.startsWith('.'))) return next();
    const file = path.resolve(base, `.${rel}`);
    if (!file.startsWith(base + path.sep)) return next();
    fs.stat(file, (err, st) => (err || !st.isFile() ? next() : sendFile(req, res, file, { maxAge })));
  };
}

// ---------- приложение ----------

// Адрес соединения — локальный прокси (Nginx на этой же машине или в частной сети)?
// Только таким соединениям верим в X-Forwarded-For: иначе при прямом доступе к Node
// клиент подставил бы любой IP и обошёл ограничение попыток входа.
export function isTrustedPeer(addr = '') {
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (a === '::1' || a.startsWith('127.') || a.startsWith('10.') || a.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(a); // IPv6 ULA fc00::/7
}

/**
 * @param {{ trustProxy: () => number }} opts — сколько прокси перед приложением (для req.ip)
 */
export function createApp({ trustProxy = () => 0 } = {}) {
  const root = Router();

  const handler = (req, res) => {
    const q = req.url.indexOf('?');
    req.path = q === -1 ? req.url : req.url.slice(0, q);
    req.routePath = req.path;
    req.originalUrl = req.url;
    req.query = Object.fromEntries(new URLSearchParams(q === -1 ? '' : req.url.slice(q + 1)));
    req.get = (name) => req.headers[name.toLowerCase()];

    // req.ip как в Express с trust proxy = N: адрес на N шагов от нас по X-Forwarded-For.
    const peer = req.socket.remoteAddress ?? '';
    const chain = [peer,
      ...(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).reverse()];
    req.ip = isTrustedPeer(peer) ? chain[Math.min(trustProxy(), chain.length - 1)] : peer;

    root(req, res, (err) => {
      if (err) {
        console.error('Необработанная ошибка:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        else res.destroy();
      } else if (!res.headersSent) {
        res.status(404).type('text/plain; charset=utf-8').send('Not found');
      }
    });
  };

  root.listen = (port, host, cb) => http.createServer(handler).listen(port, host, cb);
  return root;
}

// Express-подобные методы ответа.
const proto = http.ServerResponse.prototype;
proto.status = function status(code) { this.statusCode = code; return this; };
proto.set = function set(name, value) { this.setHeader(name, value); return this; };
proto.type = function type(value) { this.setHeader('Content-Type', value); return this; };
proto.send = function send(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  if (!this.hasHeader('Content-Type')) this.setHeader('Content-Type', 'text/html; charset=utf-8');
  this.setHeader('Content-Length', buf.length);
  this.end(this.req?.method === 'HEAD' ? undefined : buf);
  return this;
};
proto.json = function jsonResponse(obj) {
  this.setHeader('Content-Type', 'application/json; charset=utf-8');
  return this.send(JSON.stringify(obj));
};
proto.redirect = function redirect(code, url) {
  this.statusCode = code;
  this.setHeader('Location', url);
  return this.end();
};
proto.sendFile = function sendFileResponse(file, opts) { sendFile(this.req, this, file, opts); return this; };

function cookieString(name, value, { httpOnly, secure, sameSite, path: p = '/', maxAge, expires } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${p}`;
  if (maxAge !== undefined) {
    s += `; Max-Age=${Math.floor(maxAge / 1000)}`;
    expires ??= new Date(Date.now() + maxAge);
  }
  if (expires) s += `; Expires=${expires.toUTCString()}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (sameSite) s += `; SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`;
  return s;
}
proto.cookie = function cookie(name, value, opts) {
  const prev = this.getHeader('Set-Cookie');
  this.setHeader('Set-Cookie', [...[prev ?? []].flat(), cookieString(name, value, opts)]);
  return this;
};
proto.clearCookie = function clearCookie(name, opts) {
  return this.cookie(name, '', { ...opts, maxAge: undefined, expires: new Date(0) });
};
