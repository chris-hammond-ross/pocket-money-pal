import { defineProject } from 'vitest/config';

// Pure modules only for now (lib/native.ts); add jsdom here once there are component tests.
export default defineProject({
  test: { name: 'web', environment: 'node', include: ['src/**/*.test.ts'] },
});
