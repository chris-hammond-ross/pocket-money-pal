import { eq } from 'drizzle-orm';
import { serverKv } from '../db/schema';
import type { DbOrTx } from './db';

/** Keys in `server_kv` (ADR 0009, ADR 0010, ADR 0012). */
export type KvKey = 'vapid' | 'secure_url' | 'payday-notified' | 'streaks-built';

export function getKv(db: DbOrTx, key: KvKey): string | null {
  return db.select().from(serverKv).where(eq(serverKv.key, key)).get()?.value ?? null;
}

export function setKv(db: DbOrTx, key: KvKey, value: string): void {
  db.insert(serverKv)
    .values({ key, value })
    .onConflictDoUpdate({
      target: serverKv.key,
      set: { value, updatedAt: new Date().toISOString() },
    })
    .run();
}
