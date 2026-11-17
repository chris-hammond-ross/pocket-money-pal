// The server's whole suite again, with better-sqlite3 swapped for the node:sqlite shim that
// the Android build bundles (ADR 0029). Keeps the two drivers interchangeable.
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      'better-sqlite3': fileURLToPath(new URL('./src/db/node-sqlite-compat.ts', import.meta.url)),
    },
  },
  test: {
    name: 'server-on-node-sqlite',
    environment: 'node',
    // Drizzle imports better-sqlite3 itself; inline it so the alias reaches that import too.
    server: { deps: { inline: ['drizzle-orm'] } },
  },
});
