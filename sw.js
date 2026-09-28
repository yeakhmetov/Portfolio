// Офлайн-режим: приложение хранится на телефоне.
// При наличии сети берётся свежая версия с сервера, без сети — сохранённая копия.
// Запросы к другим сайтам (котировки) не перехватываются, кроме шрифтов.
const VERSION = 'portfolio-v1';
const CORE = ['./', './index.html', './core.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
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
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(req, { cache: 'no-cache', signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch (_) {
      const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('./index.html') : null);
      return hit || new Response('Нет сети', { status: 503 });
    }
  })());
});
