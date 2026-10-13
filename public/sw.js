// Service worker: установка как приложения (PWA), «Поделиться» → файлы в файлообменник,
// заглушка без сети. Данные (API, файлы) НЕ кешируются: всё актуальное — с сервера.
const SHELL = 'fm-shell-v1';
const INBOX = 'fm-share-inbox';
const SHELL_FILES = ['/offline.html', '/css/app.css', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== SHELL && name !== INBOX) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match('/offline.html')) ?? Response.error()));
  }
});

// Файлы из «Поделиться» (Android): кладём во временный кеш и открываем «Входящие» —
// там пользователь выбирает папку. До загрузки файлы не покидают устройство.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(INBOX);
    const stamp = Date.now();
    let n = 0;
    for (const file of form.getAll('files')) {
      if (!(file instanceof File)) continue;
      await cache.put(`/share-inbox/${stamp}-${n++}`, new Response(file, {
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Name': encodeURIComponent(file.name || 'файл'), 'X-Time': String(stamp) },
      }));
    }
    const text = [form.get('title'), form.get('text'), form.get('url')].filter((v) => typeof v === 'string' && v.trim()).join('\n');
    if (text) {
      await cache.put(`/share-inbox/${stamp}-text`, new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Kind': 'text', 'X-Time': String(stamp) } }));
    }
  } catch {
    // Пустая или повреждённая отправка — просто откроем приложение.
  }
  return Response.redirect('/#/inbox', 303);
}
