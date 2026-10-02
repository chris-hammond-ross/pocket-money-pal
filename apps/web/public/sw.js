/*
 * Pocket Money Pal's service worker for /parent (ADR 0002, ADR 0009). It's registered only
 * on secure origins (HTTPS, or localhost in development), so plain HTTP never sees it.
 *
 * - Page loads go to the network first, so the app is always the build the server serves
 *   (ADR 0011). The cached shell is only for when the server can't be reached. Hashed
 *   /assets/ files never change, so they're cache-first; a new shell prunes the old ones.
 * - /api and /ws always go to the network: the family's data is never cached here.
 * - Push: claim notifications from the server, and what tapping one does.
 */
// v2: v1 could hold an HTML page cached as a script (an old server answered missing
// /assets/ files with the page), which left the app blank. Bumping it clears that.
// v3: v1 and v2 answered page loads from the cache, so the first launch after an update
// ran the old build, asking for files that might be gone (a blank screen). ADR 0011.
const CACHE = 'pmp-shell-v3';
const CACHE_FIRST_SHELLS = ['pmp-shell-v1', 'pmp-shell-v2'];
const SHELL = '/parent';
/** How long a page load waits for the server before falling back to the cached shell. */
const NETWORK_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  const activated = (async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    return keys.some((k) => CACHE_FIRST_SHELLS.includes(k));
  })();
  event.waitUntil(activated);
  // Taking over from a cache-first worker: its open pages may be an old build that knows
  // nothing about updates. Reload them once onto the current one. Not inside waitUntil:
  // their page loads wait for this worker to finish activating, so that would deadlock.
  void activated.then(async (fromCacheFirst) => {
    if (!fromCacheFirst) return;
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.map((w) => w.navigate(w.url).catch(() => undefined)));
  });
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  // Every /parent page is the same single-page app: the server's shell, or the cached one
  // when the server doesn't answer in time.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const fresh = fetch(SHELL).then(async (res) => {
          if (res.ok) event.waitUntil(keepShell(cache, res.clone()));
          return res;
        });
        const timeout = new Promise((done) => setTimeout(done, NETWORK_MS, null));
        const res = await Promise.race([fresh.catch(() => null), timeout]);
        if (res) return res;
        // Too slow or unreachable: the cached shell if there is one, else keep waiting.
        return (await cache.match(SHELL)) ?? fresh;
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

/** Caches a new shell. If it's a new build, drops the files only the old one used. */
async function keepShell(cache, res) {
  const html = await res.clone().text();
  const old = await cache.match(SHELL);
  await cache.put(SHELL, res);
  if (!old || (await old.text()) === html) return;
  const wanted = new Set(html.match(/\/assets\/[^"'\s)]+/g) ?? []);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((r) => {
        const path = new URL(r.url).pathname;
        return path.startsWith('/assets/') && !wanted.has(path);
      })
      .map((r) => cache.delete(r)),
  );
}

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
