import type { FastifyRequest } from 'fastify';
import { deviceOf } from './auth/devices';
import type { Db } from './db/client';
import { requestOrigin } from './net';
import { getKv, setKv } from './repo/kv';

/**
 * The server's HTTPS address (ADR 0009), for "Switch to secure app": the family's relay
 * address once registered (ADR 0021), then `PMP_SECURE_URL`, then the address
 * learned the first time the PC or a paired phone reaches the server over HTTPS (through
 * `tailscale serve`, say). `req.protocol` is only taken from loopback proxies, and a
 * stranger's request never teaches it, so it can't be pointed at another site.
 */
export class SecureUrl {
  private learned: string | null;

  constructor(
    private readonly db: Db,
    private readonly fixed: string | null,
    /** The relay address, while the PC is registered. */
    private readonly relay: () => string | null = () => null,
  ) {
    this.learned = getKv(db, 'secure_url');
  }

  get(): string | null {
    return this.relay() ?? this.fixed ?? this.learned;
  }

  /** Call on each request: remembers its origin if it came over HTTPS from someone trusted. */
  learn(req: FastifyRequest): void {
    if (this.fixed || req.protocol !== 'https') return;
    const origin = `https://${req.host}`;
    if (origin === this.learned) return;
    if (requestOrigin(req) !== 'pc' && !deviceOf(this.db, req)) return;
    setKv(this.db, 'secure_url', origin);
    this.learned = origin;
  }
}
