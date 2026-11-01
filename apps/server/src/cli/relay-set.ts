/**
 * `npm run relay:set -w @pmp/server -- <kioskId> <secret> <url>` stores a relay
 * registration by hand, and `-- --clear` removes it. Development only, until the phone can
 * register (session 9.4). Uses the server's database (`PMP_DB_PATH`). A running server
 * notices the write within a couple of seconds and connects to `PMP_RELAY_URL`.
 */
import { relayRecordSchema } from '@pmp/shared';
import { loadConfig } from '../config';
import { openDb } from '../db/client';
import { clearRelayRecord, setRelayRecord } from '../relay/record';

const args = process.argv.slice(2);
const config = loadConfig();
const { db, close } = openDb(config.dbPath, config.migrationsDir);
try {
  if (args[0] === '--clear') {
    clearRelayRecord(db);
    console.log(`Removed the relay registration from ${config.dbPath}.`);
  } else {
    const [kioskId, secret, url] = args;
    const parsed = relayRecordSchema.safeParse({ kioskId, secret, url, licenceHint: 'DEV' });
    if (!parsed.success) {
      console.error('Usage: relay:set -- <kioskId> <secret> <url>   or   relay:set -- --clear');
      process.exitCode = 1;
    } else {
      setRelayRecord(db, parsed.data);
      console.log(`Stored the relay registration for ${parsed.data.url} in ${config.dbPath}.`);
    }
  }
} finally {
  close();
}
