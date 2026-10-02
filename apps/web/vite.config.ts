import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Keep in sync with DEFAULT_PORT / WS_PATH in @pmp/shared. The config is loaded by
// plain Node, which can't import the shared package's TypeScript source.
const server = 'http://localhost:4789';
// Keep in sync with DEV_BUILD in @pmp/shared (packages/shared/src/version.ts).
const DEV_BUILD = 'dev';

/**
 * Stamps each production build with an id (ADR 0011): compiled into the client as
 * `__PMP_BUILD__`, and written to `build.json` for the server to report. A screen whose id
 * differs from the server's is running an old build.
 */
function buildStamp(build: string): Plugin {
  return {
    name: 'pmp-build-stamp',
    config: () => ({ define: { __PMP_BUILD__: JSON.stringify(build) } }),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build }) });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    buildStamp(command === 'build' ? `${Date.now().toString(36)}-${randomSuffix()}` : DEV_BUILD),
  ],
  server: {
    host: true, // reachable from phones on the LAN during development
    port: 5173,
    // xfwd: pass the client's address on, so the server can tell a phone from the PC (ADR 0005).
    proxy: {
      '/api': { target: server, xfwd: true },
      '/ws': { target: server, ws: true, xfwd: true },
    },
  },
}));

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
