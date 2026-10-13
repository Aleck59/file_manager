// Вход через Яндекс ID и Google (OAuth 2.0, authorization code + PKCE).
// Новых пользователей вход не создаёт: администратор указывает почту у существующего
// пользователя, и вход через провайдера с этой (подтверждённой) почтой — это вход под ним.
//
// state и code_verifier лежат в подписанной HttpOnly-cookie на 10 минут (SameSite=Lax —
// иначе браузер не пришлёт её при возврате с сайта провайдера).
import crypto from 'node:crypto';
import { config } from './config.js';

const PROVIDERS = {
  yandex: {
    name: 'Яндекс',
    auth: 'https://oauth.yandex.ru/authorize',
    token: 'https://oauth.yandex.ru/token',
    userinfo: 'https://login.yandex.ru/info?format=json',
    scope: 'login:email',
    authHeader: (t) => `OAuth ${t}`,
    email: (u) => ({ email: u.default_email, verified: Boolean(u.default_email) }),
  },
  google: {
    name: 'Google',
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email',
    authHeader: (t) => `Bearer ${t}`,
    email: (u) => ({ email: u.email, verified: u.email_verified === true || u.email_verified === 'true' }),
  },
};

// Только для автотестов (подставной провайдер на localhost); в эксплуатации не задаётся.
try {
  const override = JSON.parse(process.env.OAUTH_ENDPOINTS_OVERRIDE || 'null');
  for (const [id, urls] of Object.entries(override ?? {})) if (PROVIDERS[id]) Object.assign(PROVIDERS[id], urls);
} catch { /* некорректный JSON — игнорируем */ }

export const COOKIE = 'fm_oauth';
const TTL = 10 * 60;
const fail = (code, message) => Object.assign(new Error(message), { code });

export const enabledProviders = () => Object.keys(PROVIDERS).filter((id) => config.oauth?.[id])
  .map((id) => ({ id, name: PROVIDERS[id].name }));

export const isProvider = (id) => Boolean(PROVIDERS[id] && config.oauth?.[id]);
const redirectUri = (id) => `${config.appOrigin}/api/auth/oauth/${id}/callback`;
const sign = (v) => crypto.createHmac('sha256', config.auth.sessionSecret).update(`oauth|${v}`).digest('base64url');

/** Начало входа: адрес провайдера и значение cookie. */
export function start(id) {
  const p = PROVIDERS[id];
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const payload = `${id}.${state}.${verifier}.${exp}`;
  const url = new URL(p.auth);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.oauth[id].id, redirect_uri: redirectUri(id), scope: p.scope, state,
    code_challenge: challenge, code_challenge_method: 'S256',
    ...(id === 'google' && { prompt: 'select_account' }),
    ...(id === 'yandex' && { force_confirm: 'yes' }),
  }).toString();
  return { url: url.toString(), cookie: `${payload}.${sign(payload)}`, maxAge: TTL * 1000 };
}

/** Возврат от провайдера: проверка state, обмен кода на токен, почта пользователя. */
export async function finish(id, query, cookieValue) {
  const parts = String(cookieValue ?? '').split('.');
  if (parts.length !== 5) throw fail('expired', 'Сессия входа истекла — попробуйте ещё раз');
  const [cid, state, verifier, exp, sig] = parts;
  const payload = parts.slice(0, 4).join('.');
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || cid !== id || !(Number(exp) > Date.now() / 1000)) {
    throw fail('expired', 'Сессия входа истекла — попробуйте ещё раз');
  }
  if (query.error) throw fail('denied', 'Вход отменён');
  if (typeof query.state !== 'string' || query.state !== state) throw fail('state', 'Не совпадает проверочный код входа — попробуйте ещё раз');
  if (typeof query.code !== 'string' || !query.code || query.code.length > 2048) throw fail('failed', 'Провайдер не вернул код входа');

  const p = PROVIDERS[id];
  const signal = AbortSignal.timeout(10_000);
  const tokenRes = await fetch(p.token, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri(id),
      client_id: config.oauth[id].id, client_secret: config.oauth[id].secret, code_verifier: verifier,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.access_token) {
    console.error(`[oauth ${id}] обмен кода не удался: HTTP ${tokenRes.status} ${token.error ?? ''}`);
    throw fail('failed', 'Не удалось завершить вход через провайдера');
  }
  const infoRes = await fetch(p.userinfo, { signal, headers: { Authorization: p.authHeader(token.access_token), Accept: 'application/json' } });
  const info = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok) throw fail('failed', 'Провайдер не отдал данные профиля');
  const { email, verified } = p.email(info);
  if (!email || !verified) throw fail('noemail', 'У аккаунта нет подтверждённой почты');
  return { email: String(email).toLowerCase(), provider: p.name };
}
