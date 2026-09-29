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
    webDist: existsSync(resolve(webDist, 'index.html')) ? webDist : null,
  };
}
