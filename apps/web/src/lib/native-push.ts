/**
 * Notifications in the parents' app (ADR 0033, ADR 0037). The app is the "browser" here: it
 * holds the push keys, gets a token from FCM and hands the page an ordinary Web Push
 * subscription whose endpoint is the push gateway. The page stores it on this phone's device
 * record exactly as a browser's, so the server sends to it like any other.
 *
 * `pwa.ts`'s push functions come here when the page is in the app, so the Setup tab's switch
 * and the opt-in after pairing work unchanged.
 */
import { nativeCan, type PushSubscriptionInput } from '@pmp/shared';
import { nativeInfo, nativeRequest } from './native';

export type PushState = 'unavailable' | 'denied' | 'off' | 'on';

/** The server's side of push (`api`), passed in so tests can stand in for it. */
export interface PushServer {
  pushKey(): Promise<{ publicKey: string }>;
  savePushSubscription(sub: PushSubscriptionInput): Promise<unknown>;
  deletePushSubscription(): Promise<unknown>;
}

/** This app can do push (an app from before session 12.4 can't). */
async function appCanPush(): Promise<boolean> {
  return nativeCan(await nativeInfo(), 'push');
}

export async function nativePushState(): Promise<PushState> {
  if (!(await appCanPush())) return 'unavailable';
  const { state, subscribed } = await nativeRequest('push.permission');
  if (state === 'denied') return 'denied';
  return state === 'granted' && subscribed === true ? 'on' : 'off';
}

/**
 * Asks Android's question if it hasn't been asked (call it from a tap), then subscribes and
 * stores the subscription. If the PC can't store it, the app drops it again, so the switch
 * never says "on" for a phone the server won't notify.
 */
export async function nativeEnablePush(server: PushServer): Promise<PushState> {
  if (!(await appCanPush())) return 'unavailable';
  const { state } = await nativeRequest('push.permission', { ask: true });
  if (state !== 'granted') return state === 'denied' ? 'denied' : 'off';
  const { publicKey } = await server.pushKey();
  const sub = await nativeRequest('push.subscribe', { applicationServerKey: publicKey });
  try {
    await server.savePushSubscription(sub);
  } catch (err) {
    await nativeRequest('push.unsubscribe').catch(() => undefined);
    throw err;
  }
  return 'on';
}

export async function nativeDisablePush(server: PushServer): Promise<PushState> {
  if (!(await appCanPush())) return 'unavailable';
  await nativeRequest('push.unsubscribe');
  await server.deletePushSubscription();
  return nativePushState();
}

/**
 * On start-up: if the app is subscribed, store its subscription again. It may carry a new FCM
 * token the app couldn't send itself, and a re-paired phone is a new device.
 */
export async function nativeResyncPush(server: PushServer): Promise<void> {
  if ((await nativePushState()) !== 'on') return;
  const { publicKey } = await server.pushKey();
  const sub = await nativeRequest('push.subscribe', { applicationServerKey: publicKey });
  await server.savePushSubscription(sub);
}
