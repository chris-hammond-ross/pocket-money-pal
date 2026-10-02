/**
 * First-run setup (spec 003, ADR 0005): the one-time setup token, the server-side draft,
 * and finishing setup in one transaction.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { setupDraftSchema, zonedDateOf, type SetupDraft, type SetupRequest } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { setupDrafts } from '../db/schema';
import { ensureDayIn, type EnsureDayResult } from '../scheduler';
import { insertChore } from './chores';
import { ConflictError, type DbOrTx } from './db';
import { pairDevice } from './devices';
import { recordEvent } from './events';
import { restartPaydaySchedule, updateSettings } from './settings';
import { insertChild, insertParent, listParents } from './users';

const DRAFT_ID = 1;

/** Setup runs while the family has no parents. */
export function isSetupNeeded(db: DbOrTx): boolean {
  return listParents(db).length === 0;
}

function draftRow(db: DbOrTx) {
  return db.select().from(setupDrafts).where(eq(setupDrafts.id, DRAFT_ID)).get();
}

/** The setup token shown in the kiosk's QR code, created on first use. */
export function getSetupToken(db: DbOrTx): string {
  const row = draftRow(db);
  if (row?.token) return row.token;
  const token = randomBytes(32).toString('base64url');
  db.insert(setupDrafts)
    .values({ id: DRAFT_ID, data: {}, token })
    .onConflictDoUpdate({ target: setupDrafts.id, set: { token } })
    .run();
  return token;
}

/** Whether `token` is the current setup token (compared in constant time). */
export function isSetupToken(db: DbOrTx, token: string | undefined): boolean {
  const expected = draftRow(db)?.token;
  if (!token || !expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The saved draft, or null if there's none (or it no longer matches the schema). */
export function getDraft(db: DbOrTx): SetupDraft | null {
  const parsed = setupDraftSchema.safeParse(draftRow(db)?.data);
  return parsed.success ? parsed.data : null;
}

/** Replaces the draft. Keeps the setup token. */
export function saveDraft(db: DbOrTx, draft: SetupDraft, now: number): void {
  const updatedAt = new Date(now).toISOString();
  db.insert(setupDrafts)
    .values({ id: DRAFT_ID, data: draft, updatedAt })
    .onConflictDoUpdate({ target: setupDrafts.id, set: { data: draft, updatedAt } })
    .run();
}

export interface CompleteSetupArgs {
  request: SetupRequest;
  now: number;
  /** Pair the calling device to the first parent (not on the family PC; ADR 0005). */
  pairAs: { deviceName: string } | null;
}

export interface CompleteSetupResult {
  parentId: number;
  deviceToken: string | null;
  day: EnsureDayResult;
}

/**
 * Finishes setup in one transaction: parents, children, chores, the rate and time zone,
 * today's board, the audit event, and the device pairing. The draft and its token go.
 * Throws ConflictError if another device finished setup first.
 */
export function completeSetup(db: Db, args: CompleteSetupArgs): CompleteSetupResult {
  const { request, now } = args;
  return db.transaction((tx) => {
    if (!isSetupNeeded(tx)) throw new ConflictError('Setup is already done');

    const parentIds = request.parents.map((p) => insertParent(tx, p).id);
    const firstParent = parentIds[0]!;

    const childIds = new Map<string, number>();
    request.children.forEach(({ key, ...child }, sortOrder) => {
      childIds.set(key, insertChild(tx, { ...child, sortOrder }).id);
    });

    for (const { childKeys, ...chore } of request.chores) {
      insertChore(
        tx,
        chore,
        childKeys.map((k) => childIds.get(k)!),
      );
    }

    const settings = updateSettings(tx, {
      centsPerPoint: request.centsPerPoint,
      ...(request.timezone && { timezone: request.timezone }),
    });
    // The first payday is the first slot after setup, not last Sunday's (ADR 0010).
    restartPaydaySchedule(tx, now);

    recordEvent(tx, {
      type: 'setup.completed',
      at: now,
      actorId: firstParent,
      data: {
        parents: parentIds.length,
        children: childIds.size,
        chores: request.chores.length,
        centsPerPoint: settings.centsPerPoint,
        timezone: settings.timezone,
      },
    });

    let deviceToken: string | null = null;
    if (args.pairAs) {
      const paired = pairDevice(tx, { userId: firstParent, name: args.pairAs.deviceName, now });
      deviceToken = paired.token;
      recordEvent(tx, {
        type: 'device.paired',
        at: now,
        actorId: firstParent,
        data: { deviceId: paired.device.id, name: paired.device.name, via: 'setup' },
      });
    }

    const day = ensureDayIn(tx, zonedDateOf(now, settings.timezone), now);
    tx.delete(setupDrafts).where(eq(setupDrafts.id, DRAFT_ID)).run();

    return { parentId: firstParent, deviceToken, day };
  });
}
