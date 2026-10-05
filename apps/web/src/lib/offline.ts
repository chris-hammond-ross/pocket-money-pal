/**
 * Whether this phone can reach the family PC, and the parent app's last data kept on the
 * phone, so the app still opens while the PC is off (spec 007, ADR 0017). Offline planning
 * needs the service worker, so it only switches on where one controls the page (the
 * installed HTTPS app); elsewhere the app behaves as it always has.
 */
import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

/** The service worker controls this page, so changes can wait in the queue. */
export function canQueue(): boolean {
  return window.isSecureContext && !!navigator.serviceWorker?.controller;
}

// ---------------------------------------------------------------------------
// Reachability

let reachable = true;
/** The PC has stayed unreachable for a few seconds (a restart is quicker than that). */
let pcOff = false;
let offTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const SYNCED_KEY = 'pmp-pc-synced-at';

function setReachable(next: boolean) {
  if (next === reachable) return;
  reachable = next;
  clearTimeout(offTimer);
  if (next) pcOff = false;
  else {
    offTimer = setTimeout(() => {
      pcOff = true;
      listeners.forEach((l) => l());
    }, OFF_AFTER_MS);
  }
  listeners.forEach((l) => l());
}

/** Something answered from the PC. `date` is its `Date` header: the PC's clock. */
export function noteReachable(date: string | null): void {
  setReachable(true);
  const at = date ? Date.parse(date) : NaN;
  if (Number.isFinite(at)) {
    try {
      localStorage.setItem(SYNCED_KEY, String(at));
    } catch {
      // No storage: the queue falls back to this phone's clock.
    }
  }
}

/** A request or the WebSocket couldn't reach the PC. */
export function noteUnreachable(): void {
  setReachable(false);
}

export function isReachable(): boolean {
  return reachable;
}

/** The PC's clock when this phone last heard from it, sent with each queued change. */
export function lastSyncedAt(): number {
  try {
    const at = Number(localStorage.getItem(SYNCED_KEY));
    if (at > 0) return at;
  } catch {
    // No storage.
  }
  return Date.now();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How long the PC must stay unreachable before the phone says it's off (a restart is quick). */
const OFF_AFTER_MS = 3000;

/**
 * `'off'` once the PC has been unreachable for a few seconds and changes can be queued,
 * else `'on'`. Without a service worker it's always `'on'`: nothing can wait.
 */
export function useFamilyPc(): 'on' | 'off' {
  return useSyncExternalStore(subscribe, () => (pcOff && canQueue() ? 'off' : 'on'));
}

// ---------------------------------------------------------------------------
// The parent app's last data

const CACHE_KEY = 'pmp-parent-cache';
/** What the phone keeps: enough to show the tabs that can plan offline. */
const KEPT = ['device-me', 'setup-status', 'settings', 'chores', 'day', 'players', 'chore-library'];
const SAVE_EVERY_MS = 1000;

const onParentApp = () => location.pathname.startsWith('/parent');

/**
 * Restores the parent app's last data (only where it can be used offline), then keeps it
 * up to date as queries change. Call once, before the app renders.
 */
export function keepParentData(queryClient: QueryClient): void {
  if (onParentApp() && canQueue()) {
    try {
      const saved = localStorage.getItem(CACHE_KEY);
      if (saved) hydrate(queryClient, JSON.parse(saved));
    } catch {
      // Nothing kept, or it's unreadable: start empty.
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  queryClient.getQueryCache().subscribe(() => {
    if (timer || !onParentApp()) return;
    timer = setTimeout(() => {
      timer = undefined;
      saveParentData(queryClient);
    }, SAVE_EVERY_MS);
  });
}

function saveParentData(queryClient: QueryClient) {
  // A phone that isn't paired keeps nothing.
  if (queryClient.getQueryData(['device-me']) === null) return forgetParentData();
  const state = dehydrate(queryClient, {
    shouldDehydrateQuery: (q) => q.state.data !== undefined && KEPT.includes(String(q.queryKey[0])),
  });
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    // Full or blocked: the app still works online.
  }
}

/** Unpaired: the phone forgets the family's data. */
export function forgetParentData(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(SYNCED_KEY);
  } catch {
    // Nothing to forget.
  }
}
