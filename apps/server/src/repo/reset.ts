/**
 * Factory reset (ADR 0014): every family table is emptied, so the server is back where a
 * fresh install starts, with setup needed and a new setup token.
 */
import type Database from 'better-sqlite3';
import type { Db } from '../db/client';
import type { KvKey } from './kv';
import { getSetupToken } from './setup';

/**
 * Tables a reset leaves alone: the migrations record, and `server_kv`, which is trimmed
 * instead. Every other table is emptied, including ones added later.
 */
const KEPT_TABLES = new Set(['__drizzle_migrations', 'server_kv']);

/**
 * The server's own identity survives: phones re-pair against the same push keys and address,
 * and the PC stays registered with the relay (ADR 0021).
 */
const KEPT_KV: KvKey[] = ['vapid', 'secure_url', 'relay'];

/**
 * Empties every family table (all but the migrations record and `server_kv`) and runs
 * `fill` with their names, in one transaction. Used by the factory reset and by restoring
 * a backup (ADR 0020). Foreign keys are checked at the commit, and the ledger's
 * append-only triggers are lifted until then.
 */
export function rewriteFamilyData<T>(sqlite: Database.Database, fill: (tables: string[]) => T): T {
  const tables = (
    sqlite
      .prepare(
        "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .pluck()
      .all() as string[]
  ).filter((t) => !KEPT_TABLES.has(t));
  const triggers = sqlite
    .prepare("SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger'")
    .all() as { name: string; sql: string }[];

  return sqlite.transaction(() => {
    // Rows point at each other in every direction; the checks run at commit.
    sqlite.pragma('defer_foreign_keys = ON');
    // The ledger's append-only triggers refuse DELETE: lifted for this transaction only.
    for (const t of triggers) sqlite.exec(`DROP TRIGGER main."${t.name}"`);
    for (const table of tables) sqlite.exec(`DELETE FROM main."${table}"`);
    const result = fill(tables);
    for (const t of triggers) sqlite.exec(t.sql);
    return result;
  })();
}

/**
 * Empties the family's data in one transaction and returns the new setup token. Row ids
 * keep counting up (AUTOINCREMENT), so a kiosk's remembered "last shown" ids never match
 * a new row.
 */
export function factoryReset(db: Db): string {
  const sqlite = db.$client;
  return rewriteFamilyData(sqlite, () => {
    sqlite
      .prepare(`DELETE FROM main.server_kv WHERE key NOT IN (${KEPT_KV.map(() => '?').join(', ')})`)
      .run(...KEPT_KV);
    sqlite.prepare('INSERT INTO main.family_settings (id) VALUES (1)').run();
    return getSetupToken(db);
  });
}
