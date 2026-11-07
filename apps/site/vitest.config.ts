import { defineProject } from 'vitest/config';

// The Worker's tests run in Node: Request/Response are the same, Stripe is a fetch spy, and the relay and the
// assets are stub bindings.
export default defineProject({
  test: { name: 'site', environment: 'node', include: ['worker/**/*.test.ts'] },
});
