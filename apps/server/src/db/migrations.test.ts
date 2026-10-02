import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { appendLedger } from '../repo/ledger';
import { getSettings } from '../repo/settings';
import { migrationsDir, testDb } from '../test-helpers';
import { openDb } from './client';
import { familySettings, ledger, users } from './schema';

const EXPECTED_TABLES = [
  'chore_assignments',
  'chore_instances',
  'chores',
  'devices',
  'envelopes',
  'events',
  'family_settings',
  'goals',
  'ledger',
  'pairing_codes',
  'paydays',
  'server_kv',
  'setup_drafts',
  'users',
];

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** A migrations folder holding only the Phase 0 migration. */
function phase0MigrationsDir(root: string): string {
  const dir = join(root, 'phase0');
  mkdirSync(join(dir, 'meta'), { recursive: true });
  copyFileSync(join(migrationsDir, '0000_init.sql'), join(dir, '0000_init.sql'));
  const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 1);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  return dir;
}

describe('migrations', () => {
  it('apply to a fresh database', () => {
    const { db, close } = testDb();
    const tables = db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'table' order by name`)
      .map((t) => t.name)
      .filter((name) => !name.startsWith('__') && name !== 'sqlite_sequence');
    expect(tables).toEqual(EXPECTED_TABLES);
    expect(getSettings(db).pause).toBeNull();
    close();
  });

  it('apply to a Phase 0 database and keep its data', () => {
    tmp = mkdtempSync(join(tmpdir(), 'pmp-migrate-'));
    const file = join(tmp, 'pmp.db');

    const old = new Database(file);
    migrate(drizzle(old), { migrationsFolder: phase0MigrationsDir(tmp) });
    old.exec(
      `insert into family_settings (id, family_name, timezone) values (1, 'Hammonds', 'Europe/Paris')`,
    );
    old.exec(`insert into users (role, name, pin_hash) values ('parent', 'Mum', 'scrypt$x')`);
    old.close();

    const { db, close } = openDb(file, migrationsDir);
    expect(getSettings(db)).toMatchObject({
      familyName: 'Hammonds',
      timezone: 'Europe/Paris',
      pause: null,
    });
    const mum = db.select().from(users).where(eq(users.name, 'Mum')).get();
    expect(mum).toMatchObject({ role: 'parent', age: null, pinHash: 'scrypt$x' });
    // An existing family's paydays start after the migration, not for a past Sunday.
    const settings = db.select().from(familySettings).get()!;
    expect(settings).toMatchObject({ paydayDay: 0, paydayTime: '18:00', paydayAuto: true });
    expect(Math.abs(settings.paydayChangedAt! - Date.now())).toBeLessThan(60_000);
    close();
  });
});

describe('ledger', () => {
  it('refuses UPDATE and DELETE at the database level', () => {
    const { db, close } = testDb();
    const child = db.insert(users).values({ role: 'child', name: 'Billy' }).returning().get();
    appendLedger(db, { childId: child.id, kind: 'bonus', points: 5, at: 0 });

    expect(() => db.update(ledger).set({ points: 50 }).run()).toThrow(/append-only/);
    expect(() => db.delete(ledger).run()).toThrow(/append-only/);
    expect(db.select().from(ledger).all()).toHaveLength(1);
    close();
  });
});
