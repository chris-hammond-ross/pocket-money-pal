/*
 * Pocket Money Pal's service worker for /parent (ADR 0002, ADR 0009). It's registered only
 * on secure origins (HTTPS, or localhost in development), so plain HTTP never sees it.
 *
 * - Page loads go to the network first, so the app is always the build the server serves
 *   (ADR 0011). The cached shell is only for when the server can't be reached. Hashed
 *   /assets/ files never change, so they're cache-first; a new shell prunes the old ones.
 * - /api and /ws always go to the network: the family's data is never cached here.
 * - Push: claim notifications from the server, and what tapping one does.
 * - The offline queue (spec 007, ADR 0017): it sends the changes a parent made while the
 *   family PC was off, when a page asks or Background Sync fires.
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

// ---------------------------------------------------------------------------
// The offline queue (spec 007, ADR 0017). The page queues quest and holiday changes in
// IndexedDB (`lib/outbox.ts`, which folds them with `foldOutbox` from @pmp/shared); this
// sends them, one at a time and in order, and records what the PC said. The record
// shapes are `OutboxItem` and `OutboxResult` in @pmp/shared: keep them in step.

const OUTBOX_DB = 'pmp-outbox';
const OUTBOX_STORE = 'kv';
const OUTBOX_SYNC_TAG = 'pmp-outbox';
const SEND_TIMEOUT_MS = 10000;

function openOutbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OUTBOX_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Reads `queue`, `results` and `ids`, lets `change` alter them in place, and writes them back. */
async function outboxUpdate(change) {
  const db = await openOutbox();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      const store = tx.objectStore(OUTBOX_STORE);
      const keys = ['queue', 'results', 'ids'];
      const state = {};
      let pending = keys.length;
      let out;
      for (const key of keys) {
        const get = store.get(key);
        get.onsuccess = () => {
          state[key] = get.result ?? (key === 'ids' ? {} : []);
          if (--pending > 0) return;
          out = change(state);
          for (const k of keys) store.put(state[k], k);
        };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Every open /parent window. */
async function parentWindows() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.filter((w) => new URL(w.url).pathname.startsWith('/parent'));
}

async function tellWindows(message) {
  for (const w of await parentWindows()) w.postMessage({ type: 'outbox', ...message });
}

function resultOf(item, status, fields) {
  const { op } = item;
  return {
    key: item.key,
    kind: op.kind,
    choreId: op.kind === 'pause' ? null : op.choreId,
    name: item.name,
    pause: op.kind === 'pause' ? op.pause : null,
    status,
    code: null,
    replaced: null,
    moved: null,
    at: Date.now(),
    announced: false,
    ...fields,
  };
}

/** Sends one item: `sent` (any answer below 500, with its result), `offline` or `error`. */
async function sendItem(item, ids) {
  // A quest made offline has a temporary negative id until the PC answers its create.
  const url = item.request.url.replace(/\/api\/chores\/(-\d+)$/, (whole, temp) =>
    ids[temp] ? `/api/chores/${ids[temp]}` : whole,
  );
  if (/\/api\/chores\/-\d+$/.test(url)) {
    // Its create never went through, so there's nothing to change.
    return { outcome: 'sent', result: resultOf(item, 404, { code: 'not-found' }) };
  }
  let res;
  try {
    res = await fetch(url, {
      method: item.request.method,
      body: item.request.body,
      headers: {
        ...(item.request.body !== null && { 'content-type': 'application/json' }),
        'idempotency-key': item.key,
        'x-pmp-queued': String(item.syncedAt),
      },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return { outcome: 'offline' };
  }
  if (res.status >= 500) return { outcome: 'error' };
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  const fields = {
    code: typeof body?.error === 'string' ? body.error : null,
    replaced: res.headers.get('x-pmp-replaced'),
    moved: res.headers.get('x-pmp-moved'),
  };
  if (item.op.kind === 'chore.create' && res.ok && typeof body?.id === 'number') {
    fields.choreId = body.id;
  }
  return { outcome: 'sent', result: resultOf(item, res.status, fields) };
}

/**
 * Sends the queue, oldest first. It stops at the first change that can't reach the PC (or
 * gets a server error): the rest wait for next time. A 401 means this phone was unpaired,
 * so nothing else can go either. Returns 'done', 'offline' or 'error'.
 */
async function sendQueue() {
  for (;;) {
    // Seal the next item before sending it: from now on it may have reached the PC, so the
    // page mustn't fold more changes into it (a repeat of its key gets the first answer).
    const next = await outboxUpdate((s) => {
      const item = s.queue[0];
      if (item) item.sealed = true;
      return item && { item, ids: s.ids };
    });
    if (!next) return 'done';
    const sent = await sendItem(next.item, next.ids);
    if (sent.outcome !== 'sent') return sent.outcome;
    const { result } = sent;
    const unpaired = result.status === 401;
    await outboxUpdate((s) => {
      const gone = unpaired ? s.queue : s.queue.filter((q) => q.key === next.item.key);
      s.queue = unpaired ? [] : s.queue.filter((q) => q.key !== next.item.key);
      for (const item of gone) {
        s.results.push(item.key === next.item.key ? result : resultOf(item, 401, {}));
      }
      if (next.item.op.kind === 'chore.create' && result.status < 300) {
        s.ids[String(next.item.op.choreId)] = result.choreId;
      }
    });
    await tellWindows({ done: false });
    if (unpaired) return 'done';
  }
}

let sending = null;

/** Sends the queue, one run at a time: a second request joins the run going on. */
function sendOutbox() {
  sending ??= sendQueue().finally(() => {
    sending = null;
  });
  return sending;
}

/** `outboxOutcome` in @pmp/shared. */
function outcomeOf(r) {
  if (r.kind === 'chore.delete' && r.status === 404) return 'sent';
  if (r.status >= 400) return 'failed';
  return r.replaced !== null || r.moved !== null ? 'look' : 'sent';
}

/** Sent with no window open: one notification says how it went. */
async function announceInBackground() {
  if ((await parentWindows()).length > 0) return;
  const fresh = await outboxUpdate((s) => {
    const list = s.results.filter((r) => !r.announced);
    for (const r of list) r.announced = true;
    // What went through without a hitch needn't stay.
    s.results = s.results.filter((r) => !list.includes(r) || outcomeOf(r) !== 'sent');
    return list;
  });
  if (fresh.length === 0) return;
  const n = fresh.length;
  const bad = fresh.filter((r) => outcomeOf(r) !== 'sent').length;
  // Not allowed when the parent turned notifications down: the bar says it instead.
  await self.registration
    .showNotification(
      bad > 0
        ? `⚠️ ${bad} ${bad === 1 ? 'change needs' : 'changes need'} a look`
        : `✓ ${n} ${n === 1 ? 'change' : 'changes'} sent to the family PC`,
      {
        body: bad > 0 ? 'Open the app to see what happened.' : 'The quest board is up to date.',
        tag: 'outbox',
        icon: '/parent/icon-192.png',
        badge: '/parent/badge-96.png',
        data: { url: '/parent' },
      },
    )
    .catch(() => undefined);
}

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'flush') return;
  event.waitUntil(sendOutbox().then((outcome) => tellWindows({ done: true, outcome })));
});

self.addEventListener('sync', (event) => {
  if (event.tag !== OUTBOX_SYNC_TAG) return;
  event.waitUntil(
    sendOutbox().then(async (outcome) => {
      await tellWindows({ done: true, outcome });
      await announceInBackground();
      // Rejecting asks Chrome to try again later.
      if (outcome !== 'done') throw new Error(`Queue not sent: ${outcome}`);
    }),
  );
});
