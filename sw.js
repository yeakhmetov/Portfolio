// Офлайн-режим: приложение открывается мгновенно из копии на телефоне (как в «Расходах»).
// Свежая версия файлов загружается в фоне и откроется при следующем запуске;
// при смене VERSION новый Service Worker сразу перезапускает приложение.
// Запросы к другим сайтам (котировки) не перехватываются, кроме шрифтов.
const VERSION = 'portfolio-v11';
const CORE = ['./', './index.html', './core.js', './quotes.js', './xlsx.js', './template.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './icon-192-maskable.png', './icon-512-maskable.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }
      catch (_) { return new Response('', { status: 503 }); }
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('./index.html') : null);
    const fresh = fetch(req, { cache: 'no-cache' }).then(r => { if (r.ok) c.put(req, r.clone()); return r; });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    try { return await fresh; } catch (_) { return new Response('Нет сети', { status: 503 }); }
  })());
});
