// public/sw.js — caches just enough of the app shell so /staff/order.html
// can load with zero connection. API calls are never cached (they must
// either succeed live or fail and get queued by offline.js) — this worker
// only handles the static files needed to render the page itself.
const CACHE = 'exo-shell-v1';
const SHELL = ['/staff/order.html', '/app.js', '/offline.js', '/style.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GETs for the shell files above — never intercept
  // /api/* (those need to hit the network live or fail, so offline.js's
  // queueing logic can react) and never cross-origin CDN scripts.
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || e.request.method !== 'GET') return;
  if (!SHELL.includes(url.pathname)) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => cached); // offline — fall back to whatever was cached
      return cached || network; // cache-first for instant offline loads, but still refreshes in the background
    })
  );
});
