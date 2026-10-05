/**
 * The phone's offline queue (spec 007, ADR 0017). Quest and holiday changes made while
 * the family PC is off wait here, in IndexedDB, until the service worker sends them: the
 * page asks it to whenever the PC answers, and Background Sync asks it with no window
 * open. The tabs show the queue applied, so a change looks saved straight away.
 */
import {
  applyPending,
  applyPendingPause,
  foldOutbox,
  nextTempId,
  offlineDayPlan,
  OUTBOX_HEADERS,
  OUTBOX_SYNC_TAG,
  outboxResultSchema,
  pendingChoreIds,
  zonedDateOf,
  type FamilySettings,
  type OutboxItem,
  type OutboxOp,
  type OutboxResult,
} from '@pmp/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDay } from '../components/parent/context';
import { api, ApiError, type QueueableInit } from './api';
import { canQueue, isReachable, lastSyncedAt, useFamilyPc } from './offline';

// ---------------------------------------------------------------------------
// IndexedDB: one store, `kv`, holding `queue`, `results` and `ids` (the service worker
// reads and writes the same records; keep the two in step).

const DB_NAME = 'pmp-outbox';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

/** Reads a record, lets `change` work out the new value, and writes it, in one transaction. */
async function update<T>(key: string, fallback: T, change: (value: T) => T): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let next = fallback;
      const get = store.get(key);
      get.onsuccess = () => {
        next = change((get.result as T | undefined) ?? fallback);
        store.put(next, key);
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    });
  } finally {
    db.close();
  }
}

async function read<T>(key: string, fallback: T): Promise<T> {
  return update(key, fallback, (v) => v);
}

// ---------------------------------------------------------------------------
// The queue

export interface Outbox {
  queue: OutboxItem[];
  results: OutboxResult[];
}

const EMPTY: Outbox = { queue: [], results: [] };
const CHANGED = 'pmp-outbox-changed';

/** Tells every `useOutbox` on the page to read the queue again. */
function changed() {
  window.dispatchEvent(new Event(CHANGED));
}

async function readOutbox(): Promise<Outbox> {
  if (!canQueue()) return EMPTY;
  const [queue, results] = await Promise.all([
    read<OutboxItem[]>('queue', []),
    read<unknown[]>('results', []),
  ]);
  return {
    queue,
    results: results.flatMap((r) => {
      const parsed = outboxResultSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

/** Asks the service worker to send the queue now (it does nothing when it's empty). */
export function requestFlush(): void {
  navigator.serviceWorker?.controller?.postMessage({ type: 'flush' });
}

/** Asks Chrome to send the queue in the background once it can (Background Sync). */
export async function registerBackgroundSync(): Promise<void> {
  try {
    const reg = (await navigator.serviceWorker?.ready) as
      | (ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } })
      | undefined;
    await reg?.sync?.register(OUTBOX_SYNC_TAG);
  } catch {
    // Not supported (or not allowed): the queue goes when the app is next open.
  }
}

async function enqueue(op: OutboxOp, name: string, key: string, sealed: boolean) {
  await update<OutboxItem[]>('queue', [], (queue) =>
    foldOutbox(queue, {
      key,
      op,
      name,
      queuedAt: Date.now(),
      syncedAt: lastSyncedAt(),
      ...(sealed && { sealed }),
    }),
  );
  changed();
  void registerBackgroundSync();
}

/** The id a new quest made offline gets until the PC gives it a real one. */
export async function tempChoreId(): Promise<number> {
  return nextTempId(await read<OutboxItem[]>('queue', []));
}

export async function cancelQueued(key: string): Promise<void> {
  await update<OutboxItem[]>('queue', [], (queue) => queue.filter((q) => q.key !== key));
  changed();
}

export async function dismissResult(key: string): Promise<void> {
  await update<unknown[]>('results', [], (results) =>
    results.filter((r) => (r as OutboxResult).key !== key),
  );
  changed();
}

/** Marks results as shown, and forgets the ones that went through without a hitch. */
export async function markAnnounced(keys: string[], keep: (r: OutboxResult) => boolean) {
  const shown = new Set(keys);
  await update<OutboxResult[]>('results', [], (results) =>
    results
      .filter((r) => !shown.has(r.key) || keep(r))
      .map((r) => (shown.has(r.key) ? { ...r, announced: true } : r)),
  );
  changed();
}

/** Unpaired: nothing queued on this phone can be sent any more. */
export async function clearOutbox(): Promise<void> {
  if (!canQueue()) return;
  await Promise.all([
    update('queue', [], () => []),
    update('results', [], () => []),
    update('ids', {}, () => ({})),
  ]);
  changed();
}

/** The queue and its results, kept current as either side changes them. */
export function useOutbox(): Outbox {
  const [outbox, setOutbox] = useState<Outbox>(EMPTY);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void readOutbox().then(
        (o) => live && setOutbox(o),
        () => undefined,
      );
    refresh();
    const onWorker = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'outbox') refresh();
    };
    window.addEventListener(CHANGED, refresh);
    navigator.serviceWorker?.addEventListener('message', onWorker);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, refresh);
      navigator.serviceWorker?.removeEventListener('message', onWorker);
    };
  }, []);
  return outbox;
}

// ---------------------------------------------------------------------------
// Sending, or queueing

/** How long a change waits for the PC before it's queued instead. */
const SEND_TIMEOUT_MS = 8000;

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Sends a quest or holiday change, or, when the PC can't be reached and the phone can
 * queue, queues it. A send that fails to reach the PC is queued with the same key (it may
 * have arrived, so the PC answers a repeat with its first answer).
 */
export async function sendOrQueue<T>(
  op: OutboxOp,
  name: string,
  send: (init: QueueableInit) => Promise<T>,
): Promise<{ queued: true } | { queued: false; result: T }> {
  if (!canQueue()) return { queued: false, result: await send({}) };
  const key = newIdempotencyKey();
  if (!isReachable()) {
    await enqueue(op, name, key, false);
    return { queued: true };
  }
  try {
    const result = await send({
      headers: { [OUTBOX_HEADERS.key]: key },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return { queued: false, result };
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 0)) throw err;
    await enqueue(op, name, key, true);
    return { queued: true };
  }
}

// ---------------------------------------------------------------------------
// The tabs, with the queue applied

/** The quests as they'll be once the queue is sent. */
export function usePlanChores() {
  const chores = useQuery({ queryKey: ['chores'], queryFn: api.chores });
  const { queue } = useOutbox();
  const data = useMemo(
    () => (chores.data ? applyPending(chores.data, queue) : undefined),
    [chores.data, queue],
  );
  return { ...chores, data } as typeof chores;
}

/** The family settings, with a queued holiday applied. */
export function usePlanSettings() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const { queue } = useOutbox();
  const data = useMemo<FamilySettings | undefined>(
    () =>
      settings.data && { ...settings.data, pause: applyPendingPause(settings.data.pause, queue) },
    [settings.data, queue],
  );
  return { ...settings, data } as typeof settings;
}

/** Quests with a change waiting to be sent, for the ⏳ marks. */
export function usePendingChores(): Set<number> {
  const { queue } = useOutbox();
  return useMemo(() => pendingChoreIds(queue), [queue]);
}

/**
 * A day on the Day tab. With the PC on and nothing queued, it's the PC's plan. With the
 * PC off, or changes waiting, it's worked out on the phone from the quests it knows, with
 * the queue applied (and today from this phone's clock).
 */
export function usePlanDay(date: string) {
  const queryClient = useQueryClient();
  const pc = useFamilyPc();
  const { queue } = useOutbox();
  const day = useDay(date);
  const chores = usePlanChores();
  const settings = usePlanSettings();
  const base = day.data ?? queryClient.getQueryData<NonNullable<typeof day.data>>(['day', 'today']);
  const phoneToday = usePhoneToday(base?.timezone ?? null);
  if (!(pc === 'off' || queue.length > 0) || !base || !chores.data) return day;
  const today = pc === 'off' && phoneToday !== null ? phoneToday : base.today;
  const data = {
    ...offlineDayPlan(
      base,
      date === 'today' ? today : date,
      today,
      chores.data,
      settings.data?.pause ?? null,
    ),
    clockOffsetMs: base.clockOffsetMs,
  };
  return { ...day, data } as typeof day;
}

/** Today in the family's time zone by this phone's clock, checked every minute. */
function usePhoneToday(timezone: string | null): string | null {
  const [today, setToday] = useState(() =>
    timezone === null ? null : zonedDateOf(Date.now(), timezone),
  );
  useEffect(() => {
    if (timezone === null) return;
    const check = () => setToday(zonedDateOf(Date.now(), timezone));
    check();
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, [timezone]);
  return today;
}

/** Re-reads everything once the queue has gone (the PC's events also say so). */
export function useRefetchAfterSend(): void {
  const queryClient = useQueryClient();
  const onWorker = useCallback(
    (e: MessageEvent) => {
      const data = e.data as { type?: string; done?: boolean } | null;
      if (data?.type === 'outbox' && data.done) void queryClient.invalidateQueries();
    },
    [queryClient],
  );
  useEffect(() => {
    navigator.serviceWorker?.addEventListener('message', onWorker);
    return () => navigator.serviceWorker?.removeEventListener('message', onWorker);
  }, [onWorker]);
}
