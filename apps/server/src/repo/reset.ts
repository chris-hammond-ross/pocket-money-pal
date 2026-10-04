/**
 * Factory reset (ADR 0014): every family table is emptied, so the server is back where a
 * fresh install starts, with setup needed and a new setup token.
 */
import type { Db } from '../db/client';
import type { KvKey } from './kv';
import { getSetupToken } from './setup';

/**
 * Tables a reset leaves alone: the migrations record, and `server_kv`, which is trimmed
 * instead. Every other table is emptied, including ones added later.
 */
const KEPT_TABLES = new Set(['__drizzle_migrations', 'server_kv']);

/** The server's own identity survives: phones re-pair against the same push keys and address. */
const KEPT_KV: KvKey[] = ['vapid', 'secure_url'];

/**
 * Empties the family's data in one transaction and returns the new setup token. Row ids
 * keep counting up (AUTOINCREMENT), so a kiosk's remembered "last shown" ids never match
 * a new row.
 */
export function factoryReset(db: Db): string {
  const sqlite = db.$client;
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .pluck()
    .all() as string[];
  const triggers = sqlite
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
    .all() as { name: string; sql: string }[];

  return sqlite.transaction(() => {
    // Rows point at each other in every direction; the checks run at commit, on empty tables.
    sqlite.pragma('defer_foreign_keys = ON');
    // The ledger's append-only triggers refuse DELETE: lifted for this transaction only.
    for (const t of triggers) sqlite.exec(`DROP TRIGGER "${t.name}"`);
    for (const table of tables) {
      if (!KEPT_TABLES.has(table)) sqlite.exec(`DELETE FROM "${table}"`);
    }
    sqlite
      .prepare(`DELETE FROM server_kv WHERE key NOT IN (${KEPT_KV.map(() => '?').join(', ')})`)
      .run(...KEPT_KV);
    for (const t of triggers) sqlite.exec(t.sql);
    sqlite.prepare('INSERT INTO family_settings (id) VALUES (1)').run();
    return getSetupToken(db);
  })();
}
