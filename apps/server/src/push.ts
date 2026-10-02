/**
 * Web Push for claimed chores (spec 003 "Notifications", ADR 0002 and ADR 0009).
 *
 * Phones subscribe over HTTPS only; over plain HTTP nobody has a subscription and nothing
 * here does anything. The first claim pushes at once and opens a 2-minute window; claims
 * in the window go out together when it ends, under the same tag so the notification is
 * replaced rather than buzzing again. At send time, claims already handled are dropped,
 * and nothing is sent in quiet hours.
 */
import {
  CLAIM_PUSH_TAG,
  CLAIM_PUSH_URL,
  claimPushText,
  isQuietTime,
  PUSH_BATCH_MS,
  pushSubscriptionSchema,
  zonedTimeOf,
  type PushSubscriptionInput,
} from '@pmp/shared';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import webpush from 'web-push';
import type { Db } from './db/client';
import { choreInstances, chores, devices, users } from './db/schema';
import type { DbOrTx } from './repo/db';
import { getKv, setKv } from './repo/kv';
import { getSettings } from './repo/settings';

/** What the service worker shows (`apps/web/public/sw.js`). */
export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/** Sends one message to one subscription. `gone` means the subscription is dead. */
export type PushSender = (
  subscription: PushSubscriptionInput,
  message: PushMessage,
) => Promise<{ gone: boolean }>;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** The VAPID key pair, made the first time the server starts (ADR 0009). */
export function ensureVapidKeys(db: DbOrTx): VapidKeys {
  const stored = getKv(db, 'vapid');
  if (stored) return JSON.parse(stored) as VapidKeys;
  const keys = webpush.generateVAPIDKeys();
  setKv(db, 'vapid', JSON.stringify(keys));
  return keys;
}

/** A sender through the browser vendor's push service, with `web-push`. */
export function webPushSender(keys: VapidKeys, subject: string): PushSender {
  return async (subscription, message) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(message), {
        vapidDetails: { subject, ...keys },
        // A claim is stale after a few hours; "high" asks Android to wake from Doze.
        TTL: 4 * 60 * 60,
        urgency: 'high',
        timeout: 10_000,
      });
      return { gone: false };
    } catch (err) {
      if (
        err instanceof webpush.WebPushError &&
        (err.statusCode === 404 || err.statusCode === 410)
      ) {
        return { gone: true };
      }
      throw err;
    }
  };
}

interface Subscribed {
  deviceId: number;
  subscription: PushSubscriptionInput;
}

/** Paired, unrevoked devices with a push subscription; `only` limits it to one. */
function subscribedDevices(db: DbOrTx, only?: number): Subscribed[] {
  return db
    .select({ id: devices.id, sub: devices.pushSubscription })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(
      and(
        isNull(devices.revokedAt),
        eq(users.archived, false),
        isNotNull(devices.pushSubscription),
        only === undefined ? undefined : eq(devices.id, only),
      ),
    )
    .all()
    .flatMap((d) => {
      const sub = pushSubscriptionSchema.safeParse(d.sub);
      return sub.success ? [{ deviceId: d.id, subscription: sub.data }] : [];
    });
}

export function setPushSubscription(
  db: DbOrTx,
  deviceId: number,
  subscription: PushSubscriptionInput | null,
): void {
  db.update(devices)
    .set({ pushSubscription: subscription, updatedAt: new Date().toISOString() })
    .where(eq(devices.id, deviceId))
    .run();
}

export interface NotifierOptions {
  db: Db;
  now: () => number;
  send: PushSender;
  onError?: (err: unknown) => void;
  batchMs?: number;
}

/** Batches claims into notifications. One per server; fed by the claim route. */
export class ClaimNotifier {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Claims made since the window's notification went out. */
  private held: number[] = [];
  /** The sends in flight, so tests (and shutdown) can wait for them. */
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly opts: NotifierOptions) {}

  /** A child claimed `instanceId`. */
  claimed(instanceId: number): void {
    if (this.timer) {
      this.held.push(instanceId);
      return;
    }
    this.track(this.push([instanceId]));
    this.openWindow();
  }

  private openWindow(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.held.length === 0) return;
      const batch = this.held;
      this.held = [];
      this.track(this.push(batch));
      this.openWindow();
    }, this.opts.batchMs ?? PUSH_BATCH_MS);
  }

  /**
   * One notification to every subscribed phone, outside quiet hours (ADR 0010: "payday is
   * ready" and "a jar was smashed"). Sends in the background.
   */
  notifyAll(message: PushMessage): void {
    this.track(
      (async () => {
        const { db, now } = this.opts;
        const settings = getSettings(db);
        if (isQuietTime(settings.quietHours, zonedTimeOf(now(), settings.timezone))) return;
        const targets = subscribedDevices(db);
        if (targets.length > 0) await this.sendAll(targets, message);
      })(),
    );
  }

  hasSubscription(deviceId: number): boolean {
    return subscribedDevices(this.opts.db, deviceId).length > 0;
  }

  /**
   * A test notification to one device. False when it has no subscription (or the push
   * service says it's gone, which clears it). Other failures throw.
   */
  async test(deviceId: number): Promise<boolean> {
    const [target] = subscribedDevices(this.opts.db, deviceId);
    if (!target) return false;
    const { gone } = await this.opts.send(target.subscription, {
      title: '🐷 Test from Pocket Money Pal',
      body: 'Notifications work on this phone.',
      tag: 'test',
      url: '/parent',
    });
    if (gone) setPushSubscription(this.opts.db, deviceId, null);
    return !gone;
  }

  /** Waits for every send in flight. */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all(this.inFlight);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held = [];
  }

  private track(p: Promise<void>): void {
    const tracked = p
      .catch((err) => this.opts.onError?.(err))
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
  }

  /** Sends one notification for the claims in `ids` that are still waiting. */
  private async push(ids: number[]): Promise<void> {
    const { db, now } = this.opts;
    const settings = getSettings(db);
    if (isQuietTime(settings.quietHours, zonedTimeOf(now(), settings.timezone))) return;

    const claimed = db
      .select({ id: choreInstances.id, title: chores.title, childName: users.name })
      .from(choreInstances)
      .innerJoin(chores, eq(chores.id, choreInstances.choreId))
      .innerJoin(users, eq(users.id, choreInstances.childId))
      .where(eq(choreInstances.status, 'claimed'))
      .orderBy(choreInstances.claimedAt, choreInstances.id)
      .all();
    const batch = new Set(ids);
    const still = claimed.filter((c) => batch.has(c.id));
    if (still.length === 0) return;

    const targets = subscribedDevices(db);
    if (targets.length === 0) return;
    const text = claimPushText(still, claimed.length);
    await this.sendAll(targets, { ...text, tag: CLAIM_PUSH_TAG, url: CLAIM_PUSH_URL });
  }

  private async sendAll(targets: Subscribed[], message: PushMessage): Promise<void> {
    const results = await Promise.allSettled(
      targets.map((t) => this.opts.send(t.subscription, message)),
    );
    const gone: number[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.gone) gone.push(targets[i]!.deviceId);
      if (r.status === 'rejected') this.opts.onError?.(r.reason);
    });
    if (gone.length > 0) {
      this.opts.db
        .update(devices)
        .set({ pushSubscription: null })
        .where(inArray(devices.id, gone))
        .run();
    }
  }
}
