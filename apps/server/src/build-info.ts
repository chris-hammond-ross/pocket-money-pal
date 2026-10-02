import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { API_VERSION, type ServerVersion } from '@pmp/shared';

/** Written into the web build by Vite (`apps/web/vite.config.ts`). */
export const BUILD_FILE = 'build.json';

/**
 * What the server tells clients about itself (ADR 0011). The build id is read from the
 * served web bundle each time, so a rebuild without a restart is still noticed.
 */
export function serverVersion(webDist: string | null): ServerVersion {
  return { build: webDist ? readBuild(webDist) : null, apiVersion: API_VERSION };
}

function readBuild(webDist: string): string | null {
  try {
    const { build } = JSON.parse(readFileSync(resolve(webDist, BUILD_FILE), 'utf8')) as {
      build?: unknown;
    };
    return typeof build === 'string' ? build : null;
  } catch {
    return null;
  }
}
