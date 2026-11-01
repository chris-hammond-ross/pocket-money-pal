import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import { TunnelClient, type RelayStatus, type TunnelTiming } from './client';
import { getRelayRecord } from './record';

export interface RelayOptions {
  app: FastifyInstance;
  db: Db;
  /** `PMP_RELAY_URL`, or null to never connect (tests, unless they bring a fake relay). */
  relayUrl: string | null;
  appVersion: string;
  log: FastifyBaseLogger;
  onChange?: (status: RelayStatus) => void;
  timing?: Partial<TunnelTiming>;
  random?: () => number;
}

/**
 * The PC's remote access (ADR 0021): connected while a registration is stored in
 * `server_kv`. `reload` after the registration changes (9.4's routes, or a write from
 * outside the server such as `npm run relay:set`); it's a no-op if nothing did.
 */
export class Relay {
  private client: TunnelClient | null = null;
  /** The registration the client is running for. */
  private running: string | null = null;
  private readonly off: RelayStatus = {
    state: 'off',
    since: Date.now(),
    problem: null,
    lastError: null,
    retryAt: null,
  };

  constructor(private readonly options: RelayOptions) {}

  /** The family's relay address while registered: the PC's secure address (ADR 0021). */
  url(): string | null {
    if (!this.options.relayUrl) return null;
    return getRelayRecord(this.options.db)?.url ?? null;
  }

  status(): RelayStatus {
    return this.client?.status ?? this.off;
  }

  /** The client, while one runs (tests look at it). */
  get tunnel(): TunnelClient | null {
    return this.client;
  }

  reload(): void {
    const { relayUrl, db } = this.options;
    const record = relayUrl ? getRelayRecord(db) : null;
    const key = record ? JSON.stringify([record.kioskId, record.secret, record.url]) : null;
    if (key === this.running) return;
    const old = this.client;
    this.client = null;
    this.running = key;
    if (old) void old.stop();
    if (!record || !relayUrl) {
      this.options.onChange?.(this.status());
      return;
    }
    this.client = new TunnelClient({
      app: this.options.app,
      relayUrl,
      record,
      appVersion: this.options.appVersion,
      log: this.options.log,
      onChange: (status) => this.options.onChange?.(status),
      timing: this.options.timing,
      random: this.options.random,
    });
    this.client.start();
  }

  async stop(): Promise<void> {
    const old = this.client;
    this.client = null;
    this.running = null;
    await old?.stop();
  }
}
