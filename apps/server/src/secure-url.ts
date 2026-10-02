import type { FastifyRequest } from 'fastify';
import { deviceOf } from './auth/devices';
import type { Db } from './db/client';
import { isOnPc } from './net';
import { getKv, setKv } from './repo/kv';

/**
 * The server's HTTPS address (ADR 0009), for "Switch to secure app": `PMP_SECURE_URL`, or
 * learned the first time the PC or a paired phone reaches the server over HTTPS (through
 * `tailscale serve`, say). `req.protocol` is only taken from loopback proxies, and a
 * stranger's request never teaches it, so it can't be pointed at another site.
 */
export class SecureUrl {
  private learned: string | null;

  constructor(
    private readonly db: Db,
    private readonly fixed: string | null,
  ) {
    this.learned = getKv(db, 'secure_url');
  }

  get(): string | null {
    return this.fixed ?? this.learned;
  }

  /** Call on each request: remembers its origin if it came over HTTPS from someone trusted. */
  learn(req: FastifyRequest): void {
    if (this.fixed || req.protocol !== 'https') return;
    const origin = `https://${req.host}`;
    if (origin === this.learned) return;
    if (!isOnPc(req.ip) && !deviceOf(this.db, req)) return;
    setKv(this.db, 'secure_url', origin);
    this.learned = origin;
  }
}
