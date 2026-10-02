import type { FamilySettings, FamilySettingsPatch } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import { familySettings } from '../db/schema';
import type { DbOrTx } from './db';

export function getSettings(db: DbOrTx): FamilySettings {
  const row = db.select().from(familySettings).where(eq(familySettings.id, 1)).get();
  if (!row) throw new Error('family_settings row is missing (openDb seeds it)');
  return {
    familyName: row.familyName,
    currency: row.currency,
    centsPerPoint: row.centsPerPoint,
    timezone: row.timezone,
    volume: row.volume,
    pause: row.pausedFrom === null ? null : { from: row.pausedFrom, until: row.pausedUntil },
    quietHours:
      row.quietFrom === null || row.quietUntil === null
        ? null
        : { from: row.quietFrom, until: row.quietUntil },
    payday: { day: row.paydayDay, time: row.paydayTime, auto: row.paydayAuto },
  };
}

/** When the payday day or time last changed (ADR 0010): earlier slots never start one. */
export function paydayChangedAt(db: DbOrTx): number | null {
  return (
    db
      .select({ at: familySettings.paydayChangedAt })
      .from(familySettings)
      .where(eq(familySettings.id, 1))
      .get()?.at ?? null
  );
}

/** Starts the payday schedule afresh from `now` (setup, or a new day or time). */
export function restartPaydaySchedule(db: DbOrTx, now: number): void {
  db.update(familySettings).set({ paydayChangedAt: now }).where(eq(familySettings.id, 1)).run();
}

/**
 * Applies an already-validated patch (`familySettingsPatchSchema`). A new payday day or
 * time restarts the payday schedule from `now` (ADR 0010).
 */
export function updateSettings(
  db: DbOrTx,
  patch: FamilySettingsPatch,
  now: number = Date.now(),
): FamilySettings {
  const { pause, quietHours, ...rest } = patch;
  const before = getSettings(db).payday;
  db.update(familySettings)
    .set({
      ...rest,
      ...(pause !== undefined && {
        pausedFrom: pause?.from ?? null,
        pausedUntil: pause?.until ?? null,
      }),
      ...(quietHours !== undefined && {
        quietFrom: quietHours?.from ?? null,
        quietUntil: quietHours?.until ?? null,
      }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(familySettings.id, 1))
    .run();
  const after = getSettings(db);
  if (after.payday.day !== before.day || after.payday.time !== before.time) {
    restartPaydaySchedule(db, now);
  }
  return after;
}
