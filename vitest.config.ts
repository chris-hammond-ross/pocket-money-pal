import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/server',
      // The server suite again on the node:sqlite shim the Android build uses (ADR 0029).
      'apps/server/vitest.node-sqlite.config.ts',
      'apps/desktop',
      'apps/web',
      'apps/site',
    ],
  },
});
