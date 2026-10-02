import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@pmp/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** First existing path, or the first candidate if none exist. */
function firstExisting(...candidates: string[]): string {
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  migrationsDir: string;
  /** Built React app to serve, or null if not built (e.g. during `npm run dev`). */
  webDist: string | null;
  /** Address phones should use (e.g. http://192.168.1.20:4789), if the LAN guess is wrong. */
  publicUrl: string | null;
  /** The HTTPS address (e.g. https://family-pc.tail1234.ts.net), if not learned (ADR 0009). */
  secureUrl: string | null;
  /** Contact in the VAPID token that push services see (`mailto:` or `https:`). */
  vapidSubject: string | undefined;
  /** `PMP_DEV_CLOCK=1`: the clock can be moved with `/api/dev/clock` (development only). */
  devClock: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `here` is src/ when run via tsx, or dist/ (or the Electron stage dir) when bundled.
  const webDist =
    env.PMP_WEB_DIST ?? firstExisting(resolve(here, 'web'), resolve(here, '../../web/dist'));
  return {
    port: Number(env.PMP_PORT ?? DEFAULT_PORT),
    host: env.PMP_HOST ?? '0.0.0.0',
    dbPath: env.PMP_DB_PATH ?? resolve(here, '../data/pmp.db'),
    migrationsDir:
      env.PMP_MIGRATIONS ?? firstExisting(resolve(here, 'drizzle'), resolve(here, '../drizzle')),
    publicUrl: env.PMP_PUBLIC_URL?.replace(/\/+$/, '') || null,
    secureUrl: env.PMP_SECURE_URL?.replace(/\/+$/, '') || null,
    vapidSubject: env.PMP_VAPID_SUBJECT || undefined,
    webDist: existsSync(resolve(webDist, 'index.html')) ? webDist : null,
    devClock: env.PMP_DEV_CLOCK === '1',
  };
}
