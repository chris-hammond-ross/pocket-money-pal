/**
 * `npm run devices:reset -w @pmp/server`: revokes every paired phone (ADR 0008), for when
 * every phone is lost. The kiosk then shows its "Pair a parent phone" card again. Uses the
 * same database as the server (`PMP_DB_PATH`); a running server notices the write.
 */
import { loadConfig } from '../config';
import { openDb } from '../db/client';
import { recordEvent } from '../repo/events';
import { revokeAllDevices } from '../repo/devices';

const config = loadConfig();
const { db, close } = openDb(config.dbPath, config.migrationsDir);
const now = Date.now();
const revoked = db.transaction((tx) => {
  const n = revokeAllDevices(tx, now);
  if (n > 0) recordEvent(tx, { type: 'device.revoked', at: now, data: { all: true, devices: n } });
  return n;
});
close();
console.log(`Revoked ${revoked} paired device(s) in ${config.dbPath}.`);
