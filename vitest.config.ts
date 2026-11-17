import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Add apps/web (with a jsdom vitest.config.ts) once it has component tests.
    projects: [
      'packages/*',
      'apps/server',
      // The server suite again on the node:sqlite shim the Android build uses (ADR 0029).
      'apps/server/vitest.node-sqlite.config.ts',
      'apps/desktop',
      'apps/site',
    ],
  },
});
