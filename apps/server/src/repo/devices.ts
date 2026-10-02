import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_CODE_MINUTES } from '@pmp/shared';
import { and, asc, count, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { devices, pairingCodes, users } from '../db/schema';
import type { DbOrTx } from './db';

export type Device = typeof devices.$inferSelect;

/** Name of the httpOnly cookie that carries a paired device's token (ADR 0005). */
export const DEVICE_COOKIE = 'pmp_device';

/**
 * Device tokens are 256 random bits, so a fast hash is enough: there is nothing to
 * brute-force, unlike a 4-digit PIN.
 */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** A short, readable name from the browser's user agent ("Android phone", "iPhone"). */
export function deviceNameFrom(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'Device';
}

/** Pairs a new device to a parent. Returns the plain token, which is never stored. */
export function pairDevice(
  db: DbOrTx,
  args: { userId: number; name: string; now: number },
): { device: Device; token: string } {
  const token = randomBytes(32).toString('base64url');
  const device = db
    .insert(devices)
    .values({
      userId: args.userId,
      name: args.name,
      tokenHash: hashDeviceToken(token),
      lastSeenAt: args.now,
    })
    .returning()
    .get();
  return { device, token };
}

/** The (not revoked) device holding this token, with its parent, or null. */
export function findDeviceByToken(db: DbOrTx, token: string) {
  return (
    db
      .select({ device: devices, parent: users })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(
        and(
          eq(devices.tokenHash, hashDeviceToken(token)),
          isNull(devices.revokedAt),
          eq(users.archived, false),
        ),
      )
      .get() ?? null
  );
}

/** Every paired device that isn't revoked, with its parent, oldest first. */
export function listDevices(db: DbOrTx) {
  return db
    .select({ device: devices, parent: users })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(and(isNull(devices.revokedAt), eq(users.archived, false)))
    .orderBy(asc(devices.id))
    .all();
}

export function countActiveDevices(db: DbOrTx): number {
  return listDevices(db).length;
}

/** Revokes a device. False if there's no such active device. */
export function revokeDevice(db: DbOrTx, id: number, now: number): boolean {
  const result = db
    .update(devices)
    .set({ revokedAt: now, updatedAt: new Date(now).toISOString() })
    .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
    .run();
  return result.changes === 1;
}

export function touchDevice(db: DbOrTx, id: number, now: number): void {
  db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, id)).run();
}

/** Revokes every device (`npm run devices:reset`, when every phone is lost). */
export function revokeAllDevices(db: DbOrTx, now: number): number {
  return db
    .update(devices)
    .set({ revokedAt: now, updatedAt: new Date(now).toISOString() })
    .where(isNull(devices.revokedAt))
    .run().changes;
}

function hashCode(code: string): string {
  return createHash('sha256').update(`pairing:${code}`).digest('base64url');
}

/**
 * A new one-time pairing code (ADR 0008), valid for 10 minutes. `createdByDevice` is the
 * inviting phone, or null for the PC's code. A `move` code also unpairs the inviting phone
 * when it's used (ADR 0009). Spent and expired codes are cleared out.
 */
export function createPairingCode(
  db: DbOrTx,
  args: { createdByDevice: number | null; now: number; move?: boolean },
): { code: string; expiresAt: number } {
  db.delete(pairingCodes)
    .where(or(lte(pairingCodes.expiresAt, args.now), isNotNull(pairingCodes.usedAt)))
    .run();
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++)
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  const expiresAt = args.now + PAIRING_CODE_MINUTES * 60_000;
  db.insert(pairingCodes)
    .values({
      codeHash: hashCode(code),
      createdByDevice: args.createdByDevice,
      replacesDevice: args.move ? args.createdByDevice : null,
      expiresAt,
    })
    .run();
  return { code, expiresAt };
}

export type PairingCodeProblem = 'unknown' | 'expired';

/**
 * Whether `code` can pair a phone now: known, unused and unexpired; a phone's invite only
 * while that phone is still paired; the PC's code only while no phone is paired.
 */
export function checkPairingCode(
  db: DbOrTx,
  code: string,
  now: number,
):
  | { ok: true; expiresAt: number; createdByDevice: number | null; replacesDevice: number | null }
  | { ok: false; problem: PairingCodeProblem } {
  const row = db
    .select()
    .from(pairingCodes)
    .where(eq(pairingCodes.codeHash, hashCode(code)))
    .get();
  if (!row) return { ok: false, problem: 'unknown' };
  if (row.usedAt !== null || row.expiresAt <= now) return { ok: false, problem: 'expired' };
  if (row.createdByDevice === null) {
    if (countActiveDevices(db) > 0) return { ok: false, problem: 'expired' };
  } else {
    const inviter = db
      .select({ n: count() })
      .from(devices)
      .where(and(eq(devices.id, row.createdByDevice), isNull(devices.revokedAt)))
      .get();
    if (!inviter?.n) return { ok: false, problem: 'expired' };
  }
  return {
    ok: true,
    expiresAt: row.expiresAt,
    createdByDevice: row.createdByDevice,
    replacesDevice: row.replacesDevice,
  };
}

/** Marks the code used. Call after `checkPairingCode`, in the same transaction. */
export function spendPairingCode(db: DbOrTx, code: string, now: number): void {
  db.update(pairingCodes)
    .set({ usedAt: now, updatedAt: new Date(now).toISOString() })
    .where(eq(pairingCodes.codeHash, hashCode(code)))
    .run();
}
