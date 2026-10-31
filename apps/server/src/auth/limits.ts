import type { RateLimitOptions } from '@fastify/rate-limit';

/**
 * Rate limits on remote pairing and setup calls (ADR 0021), per client address (the one
 * the relay or proxy reports) and per route: the in-memory store keeps one count per route.
 * Requests from the PC and the LAN are never limited.
 */
export const REMOTE_LIMITS = {
  /** Pairing codes are 8 of 31 letters, valid 10 minutes: guessing one is hopeless. */
  pair: { max: 10, timeWindow: 60_000 },
  /** Generous: the setup page saves its draft as the parent types (debounced). */
  setup: { max: 60, timeWindow: 60_000 },
} satisfies Record<string, RateLimitOptions>;

/** A route's options for one of the remote limits. */
export const remoteLimit = (limit: keyof typeof REMOTE_LIMITS) => ({
  config: { rateLimit: REMOTE_LIMITS[limit] },
});
