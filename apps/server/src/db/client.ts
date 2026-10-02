import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

/** Drizzle over better-sqlite3; `$client` is the raw connection (for pragmas). */
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Opens (creating if needed) the database, applies migrations and seeds defaults. */
export function openDb(dbPath: string, migrationsDir: string): { db: Db; close: () => void } {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  db.insert(schema.familySettings).values({ id: 1 }).onConflictDoNothing().run();

  return { db, close: () => sqlite.close() };
}
