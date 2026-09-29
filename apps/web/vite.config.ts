import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Keep in sync with DEFAULT_PORT / WS_PATH in @pmp/shared. The config is loaded by
// plain Node, which can't import the shared package's TypeScript source.
const server = 'http://localhost:4789';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from phones on the LAN during development
    port: 5173,
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
});
