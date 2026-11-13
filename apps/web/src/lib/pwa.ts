/**
 * Installing `/parent` as an app, and push (ADR 0002, ADR 0009). Browsers offer both to
 * secure origins only, so over plain `http://<pc-ip>` none of this switches on and the page
 * is an ordinary tab. Nothing here may assume HTTPS.
 */
import { installDeviceOf, type FinishSetupState } from '@pmp/shared';
import { useEffect, useState } from 'react';
import { api } from './api';

/** HTTPS (or `localhost` in development): service worker, install and push are possible. */
export function isSecure(): boolean {
  return window.isSecureContext && 'serviceWorker' in navigator;
}

/** This browser can do Web Push here. */
export function canPush(): boolean {
  return isSecure() && 'PushManager' in window && 'Notification' in window;
}

/** Opened from the home screen / app drawer, with no address bar. */
export function isStandalone(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

const SW_URL = '/sw.js';
const SW_SCOPE = '/parent';

/** Registers the service worker for `/parent` (secure origins only). */
export function registerServiceWorker(): void {
  if (!isSecure()) return;
  navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch((err: unknown) => {
    console.warn('Service worker not registered', err);
  });
}

// ---------------------------------------------------------------------------
// Install

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let installPrompt: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

/** Call once at start-up: Chrome offers its install prompt early, before any screen asks. */
export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep it for our own "📲 Install" button
    installPrompt = e as InstallPromptEvent;
    installListeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installedHere()[1]();
    installListeners.forEach((l) => l());
  });
}

/** Our own "📲 Install" button: null when the browser isn't offering an install. */
export function useInstallPrompt(): (() => Promise<boolean>) | null {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    installListeners.add(listener);
    return () => {
      installListeners.delete(listener);
    };
  }, []);
  if (!installPrompt) return null;
  const prompt = installPrompt;
  return async () => {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    // An answered prompt can't be shown again: wait for Chrome to offer a new one.
    if (installPrompt === prompt) installPrompt = null;
    installListeners.forEach((l) => l());
    return outcome === 'accepted';
  };
}

// ---------------------------------------------------------------------------
// Push

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration> {
  registerServiceWorker();
  return navigator.serviceWorker.ready;
}

export type PushState = 'unavailable' | 'denied' | 'off' | 'on';

/** Whether this phone gets claim notifications. */
export async function pushState(): Promise<PushState> {
  if (!canPush()) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/**
 * Asks for permission (call it from a tap), subscribes with the server's VAPID key and
 * stores the subscription on this phone's device record. Returns the new state.
 */
export async function enablePush(): Promise<PushState> {
  if (!canPush()) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  const { publicKey } = await api.pushKey();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (a reset server) can't be used: start again.
  const current = sub?.options.applicationServerKey;
  if (sub && current && !sameKey(new Uint8Array(current), keyBytes(publicKey))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
  await api.savePushSubscription(sub.toJSON());
  return 'on';
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
  await api.deletePushSubscription();
  return pushState();
}

/**
 * On start-up: if this phone is subscribed, tell the server again. The server forgets a
 * subscription the push service says is gone, and a re-paired phone has a new device.
 */
export async function resyncPush(): Promise<void> {
  if ((await pushState()) !== 'on') return;
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await api.savePushSubscription(sub.toJSON());
}

// ---------------------------------------------------------------------------
// One-time prompts, remembered on this phone

const ASKED_PUSH_KEY = 'pmp.parent.askedPush';
const HINT_KEY = 'pmp.parent.installHintDismissed';
const INSTALLED_KEY = 'pmp.parent.installed';
const MOVE_HINT_KEY = 'pmp.parent.moveHintDismissed';

function flag(key: string): [boolean, () => void] {
  let value = false;
  try {
    value = localStorage.getItem(key) === '1';
  } catch {
    // Private mode: ask again next time.
  }
  return [
    value,
    () => {
      try {
        localStorage.setItem(key, '1');
      } catch {
        // As above.
      }
    },
  ];
}

/** The push opt-in after pairing is asked once per phone. */
export const askedPush = () => flag(ASKED_PUSH_KEY);
/** The plain-HTTP install hint is dismissed once per phone. */
export const installHintDismissed = () => flag(HINT_KEY);
/** The "Move to the app" hint is dismissed once per phone (and address). */
export const moveHintDismissed = () => flag(MOVE_HINT_KEY);
/** This address was installed as an app (from this tab, so it isn't standalone itself). */
export const installedHere = () => flag(INSTALLED_KEY);

// ---------------------------------------------------------------------------
// Finish setting up (spec 009): install straight after pairing or moving

const FINISH_SETUP_KEY = 'pmp.parent.finishSetup';
/** The flag ADR 0025's after-move sheet used; a phone mid-move during the update still has it. */
const OLD_AFTER_MOVE_KEY = 'pmp.parent.afterMove';

/** Pairing (or a move) succeeded on this phone: the install screen comes next. */
export function markFinishSetup(): void {
  try {
    localStorage.setItem(FINISH_SETUP_KEY, '1');
  } catch {
    // No storage: no install screen.
  }
}

export function finishSetupPending(): boolean {
  try {
    return (
      localStorage.getItem(FINISH_SETUP_KEY) === '1' ||
      localStorage.getItem(OLD_AFTER_MOVE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

export function forgetFinishSetup(): void {
  try {
    localStorage.removeItem(FINISH_SETUP_KEY);
    localStorage.removeItem(OLD_AFTER_MOVE_KEY);
  } catch {
    // As above.
  }
}

/** The shared rule's inputs, read from this browser. */
export function finishSetupState(): FinishSetupState {
  return {
    pending: finishSetupPending(),
    secure: isSecure(),
    standalone: isStandalone(),
    installed: isInstalled(),
    device: installDeviceOf(navigator.userAgent, navigator.maxTouchPoints),
  };
}

/** Installed as an app here: opened from it, or installed from this tab. */
export function isInstalled(): boolean {
  return isStandalone() || installedHere()[0];
}
