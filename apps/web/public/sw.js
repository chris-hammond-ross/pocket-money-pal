/*
 * Pocket Money Pal's service worker for /parent (ADR 0002, ADR 0009). It's registered only
 * on secure origins (HTTPS, or localhost in development), so plain HTTP never sees it.
 *
 * - The app shell: page loads are answered from the cache straight away and refreshed in
 *   the background. Hashed /assets/ files never change, so they're cache-first.
 * - /api and /ws always go to the network: the family's data is never cached here.
 * - Push: claim notifications from the server, and what tapping one does.
 */
// v2: v1 could hold an HTML page cached as a script (an old server answered missing
// /assets/ files with the page), which left the app blank. Bumping it clears that.
const CACHE = 'pmp-shell-v2';
const SHELL = '/parent';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  // Every /parent page is the same single-page app: the cached shell, refreshed behind it.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(SHELL);
        const fresh = fetch(SHELL)
          .then((res) => {
            if (res.ok) void cache.put(SHELL, res.clone());
            return res;
          })
          .catch(() => cached);
        if (cached) {
          event.waitUntil(fresh);
          return cached;
        }
        return fresh;
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/sounds/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const res = await fetch(request);
        // Never keep a page in place of a file.
        const isPage = (res.headers.get('content-type') ?? '').includes('text/html');
        if (res.ok && !isPage) void cache.put(request, res.clone());
        return res;
      }),
    );
  }
});

self.addEventListener('push', (event) => {
  let message = { title: 'Pocket Money Pal', body: '', tag: 'claims', url: '/parent' };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    // Not JSON: show the defaults.
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      icon: '/parent/icon-192.png',
      badge: '/parent/badge-96.png',
      data: { url: message.url },
    }),
  );
});

// Tapping a notification opens /parent with the tray expanded, in the app if it's open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/parent', location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).pathname.startsWith('/parent'));
      if (open) {
        open.postMessage({ type: 'open-tray' });
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
