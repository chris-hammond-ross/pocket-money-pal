import type { ChildInput, ParentInput } from '@pmp/shared';
import { and, asc, eq } from 'drizzle-orm';
import { users } from '../db/schema';
import type { DbOrTx } from './db';

export type User = typeof users.$inferSelect;

/** Shown for a child saved without an avatar or colour (setup always sets both). */
export const FALLBACK_AVATAR = '🙂';
export const FALLBACK_COLOUR = '#4c6ef5';

/** A grown-up. There are no PINs (ADR 0008): `pin_hash` stays null. */
export function insertParent(db: DbOrTx, parent: ParentInput): User {
  return db.insert(users).values({ role: 'parent', name: parent.name }).returning().get();
}

export function insertChild(db: DbOrTx, child: ChildInput & { sortOrder?: number }): User {
  return db
    .insert(users)
    .values({
      role: 'child',
      name: child.name,
      age: child.age,
      avatar: child.avatar,
      colour: child.colour,
      sortOrder: child.sortOrder ?? 0,
    })
    .returning()
    .get();
}

/** Active children in kiosk column order. */
export function listChildren(db: DbOrTx): User[] {
  return db
    .select()
    .from(users)
    .where(and(eq(users.role, 'child'), eq(users.archived, false)))
    .orderBy(asc(users.sortOrder), asc(users.id))
    .all();
}

export function listParents(db: DbOrTx): User[] {
  return db
    .select()
    .from(users)
    .where(and(eq(users.role, 'parent'), eq(users.archived, false)))
    .orderBy(asc(users.id))
    .all();
}

/** An active parent by id, or null. */
export function findParent(db: DbOrTx, id: number): User | null {
  return listParents(db).find((p) => p.id === id) ?? null;
}
