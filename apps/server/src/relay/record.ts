import { relayRecordSchema, type RelayRecord } from '@pmp/shared';
import { eq } from 'drizzle-orm';
import { serverKv } from '../db/schema';
import type { DbOrTx } from '../repo/db';
import { getKv, setKv } from '../repo/kv';

/** The PC's registration with the relay, or null if there's none (or it can't be read). */
export function getRelayRecord(db: DbOrTx): RelayRecord | null {
  const raw = getKv(db, 'relay');
  if (!raw) return null;
  try {
    const parsed = relayRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function setRelayRecord(db: DbOrTx, record: RelayRecord): void {
  setKv(db, 'relay', JSON.stringify(relayRecordSchema.parse(record)));
}

export function clearRelayRecord(db: DbOrTx): void {
  db.delete(serverKv).where(eq(serverKv.key, 'relay')).run();
}
