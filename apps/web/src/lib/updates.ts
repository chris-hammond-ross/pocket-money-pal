/**
 * Keeping every screen on the server's current build (ADR 0011).
 *
 * The server says which build it serves and its API version, in the WebSocket `hello` (so
 * every open screen hears about an update the moment the restarted server is back) and in
 * `/api/health` (checked whenever the app comes back to the front). Then:
 *
 * - **Incompatible** (the API version changed): reload now. This build can't talk to it.
 * - **Stale** (a newer build of the same API): reload when nobody will notice. That's when
 *   the screen is hidden or was opened moments ago. Otherwise the phone shows "New version
 *   ready" and reloads the next time it's put away, and the kiosk waits for a quiet minute.
 *
 * Reloads go through `window.pmpRecover` (index.html), which escalates to dropping the
 * service worker and its caches if a reload didn't help, and never loops.
 */
import {
  API_VERSION,
  DEV_BUILD,
  serverVersionSchema,
  versionStatus,
  type VersionStatus,
} from '@pmp/shared';
import { useSyncExternalStore } from 'react';

declare const __PMP_BUILD__: string | undefined;
declare global {
  interface Window {
    /** Reload, escalating to a cache reset; false once it has given up (index.html). */
    pmpRecover?: () => boolean;
  }
}

/** This screen's build: stamped by Vite at build time, `dev` in the Vite dev server. */
export const CLIENT_BUILD = typeof __PMP_BUILD__ === 'string' ? __PMP_BUILD__ : DEV_BUILD;

/** Opened or brought back this recently: a reload now just looks like the app starting. */
const FRESH_MS = 4000;
/** The kiosk reloads after this long with nobody touching it. */
const KIOSK_IDLE_MS = 60_000;
/** Don't ask `/api/health` more often than this. */
const CHECK_GAP_MS = 10_000;

let shownAt = performance.now();
let lastInput = performance.now();
let lastCheck = 0;
let status: VersionStatus = 'current';
let idleTimer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

const isKiosk = () => location.pathname.startsWith('/kiosk');

function setStatus(next: VersionStatus): void {
  if (next === status) return;
  status = next;
  listeners.forEach((l) => l());
}

/**
 * Called with anything the server sent that may carry its version (the WebSocket hello,
 * a health response). A message without one is ignored.
 */
export function reportServerVersion(message: unknown): void {
  const parsed = serverVersionSchema.safeParse(message);
  if (!parsed.success) return;
  const next = versionStatus({ build: CLIENT_BUILD, apiVersion: API_VERSION }, parsed.data);
  setStatus(next);
  if (next === 'incompatible') void reload();
  else if (next === 'stale' && quietMoment()) void reload();
  else if (next === 'stale' && isKiosk()) waitForIdleKiosk();
}

/** Nobody is looking, or the app has only just appeared. */
function quietMoment(): boolean {
  return document.visibilityState === 'hidden' || performance.now() - shownAt < FRESH_MS;
}

function waitForIdleKiosk(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    if (status !== 'stale') {
      clearInterval(idleTimer);
      idleTimer = undefined;
    } else if (performance.now() - lastInput > KIOSK_IDLE_MS) {
      void reload();
    }
  }, 5000);
}

/**
 * Fetches the new service worker first (so the reload isn't answered by the old one), then
 * reloads. `byTap`: the parent asked, so reload even if the automatic attempts gave up.
 */
export async function reload(byTap = false): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/parent');
    await Promise.race([reg?.update(), new Promise((done) => setTimeout(done, 3000))]);
  } catch {
    // No service worker here, or the check failed: reload anyway.
  }
  const reloading = window.pmpRecover?.() ?? false;
  if (!reloading && byTap) location.reload();
}

/** Asks the server for its version (throttled); quietly does nothing if it's unreachable. */
export async function checkForUpdate(): Promise<void> {
  if (CLIENT_BUILD === DEV_BUILD || performance.now() - lastCheck < CHECK_GAP_MS) return;
  lastCheck = performance.now();
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok) reportServerVersion(await res.json());
  } catch {
    // Offline or restarting: the WebSocket hello will tell us when it's back.
  }
}

/** Call once at start-up. */
export function watchForUpdates(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Put away with an update waiting: take it now, while nobody is looking.
      if (status !== 'current') void reload();
    } else {
      shownAt = performance.now();
      void checkForUpdate();
    }
  });
  const touched = () => (lastInput = performance.now());
  window.addEventListener('pointerdown', touched, { capture: true, passive: true });
  window.addEventListener('keydown', touched, { capture: true });
  // A lazily loaded file is gone (a newer build replaced it): reload onto the new one.
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault();
    window.pmpRecover?.();
  });
}

/**
 * `stale` while a newer build waits for the parent to tap "Update"; `incompatible` only if
 * the automatic reloads gave up (the app may misbehave until it updates).
 */
export function useUpdateStatus(): VersionStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}
