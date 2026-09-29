import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Add apps/web (with a jsdom vitest.config.ts) once it has component tests.
    projects: ['packages/*', 'apps/server'],
  },
});
