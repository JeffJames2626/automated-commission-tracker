// Service worker: the app shell loads without a network, so capture works on
// a bad connection (captures themselves are kept in IndexedDB by the page).
// API calls are never cached — personal data stays out of the cache.

const VERSION = 'asst-v5';
const SHELL = [
  './', 'index.html', 'theme.js', 'app.css', 'app.js', 'api.js', 'ui.js', 'state.js', 'outbox.js', 'capture.js',
  'views/common.js', 'views/today.js', 'views/inbox.js', 'views/item.js', 'views/chat.js', 'views/search.js', 'views/more.js', 'views/dreams.js', 'views/journal.js', 'views/beta.js', 'views/link.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-180.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first (so updates arrive), falling back to the cached shell.
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok && url.pathname.startsWith('/assistant/')) {
        const c = await caches.open(VERSION);
        c.put(e.request.mode === 'navigate' ? 'index.html' : e.request, r.clone());
      }
      return r;
    } catch {
      const c = await caches.open(VERSION);
      return (await c.match(e.request, { ignoreSearch: e.request.mode === 'navigate' })) ||
        (e.request.mode === 'navigate' ? c.match('index.html') : Response.error());
    }
  })());
});
