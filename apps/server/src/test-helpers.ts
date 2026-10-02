import { resolve } from 'node:path';
import type { ChoreInput } from '@pmp/shared';
import { openDb, type Db } from './db/client';
import { insertChore } from './repo/chores';
import { DEVICE_COOKIE, pairDevice } from './repo/devices';
import { insertChild } from './repo/users';

export const migrationsDir = resolve(import.meta.dirname, '../drizzle');

/** A fresh, fully migrated in-memory database. */
export function testDb(): { db: Db; close: () => void } {
  return openDb(':memory:', migrationsDir);
}

let childCount = 0;
export function addChild(db: Db, name = `Child${++childCount}`) {
  return insertChild(db, { name, age: 9, avatar: '🦖', colour: '#228be6' });
}

/** "Make your bed", daily, unless overridden. */
export function addChore(db: Db, childIds: number[], fields: Partial<ChoreInput> = {}) {
  return insertChore(
    db,
    {
      title: 'Make your bed',
      icon: '🛏️',
      together: false,
      bonusBefore: '08:00',
      dueBy: '09:00',
      lateAfter: '12:00',
      basePoints: 5,
      earlyBonus: 3,
      unpromptedBonus: 2,
      latePenalty: 2,
      days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      oneOffDate: null,
      ...fields,
    },
    childIds,
  );
}

/** A phone on the LAN (TEST-NET-1, never one of this machine's addresses). */
export const PHONE_IP = '192.0.2.77';

/** Pairs a phone to `parentId` and returns its `cookie` header. */
export function pairedCookie(db: Db, parentId: number, now = 0): string {
  const { token } = pairDevice(db, { userId: parentId, name: 'Android phone', now });
  return `${DEVICE_COOKIE}=${token}`;
}
