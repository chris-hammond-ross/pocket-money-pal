import type { Db } from './client';

/** How often to look for writes made outside the server. */
export const WATCH_INTERVAL_MS = 2_000;

/**
 * Calls `onChange` when another connection (sqlite3, DB Browser, a second server) has
 * written to the database file. SQLite bumps `PRAGMA data_version` only for other
 * connections' commits, so the server's own writes, which already broadcast their own
 * events, don't trigger it. Returns a function that stops watching.
 */
export function watchExternalWrites(
  db: Db,
  onChange: () => void,
  intervalMs = WATCH_INTERVAL_MS,
): () => void {
  const version = () => db.$client.pragma('data_version', { simple: true }) as number;
  let last = version();
  const timer = setInterval(() => {
    const current = version();
    if (current !== last) {
      last = current;
      onChange();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
