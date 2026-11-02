import type { RelayInfo, RelayRecord } from '@pmp/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import { TunnelClient, type RelayStatus, type TunnelTiming } from './client';
import { getRelayRecord } from './record';
import { unregisterFromRelay } from './register';

export interface RelayOptions {
  app: FastifyInstance;
  db: Db;
  /** `PMP_RELAY_URL`, or null to never connect (tests, unless they bring a fake relay). */
  relayUrl: string | null;
  appVersion: string;
  log: FastifyBaseLogger;
  onChange?: (status: RelayStatus) => void;
  /** The plain home-network address, for `info()` (spec 008's "without internet?"). */
  lanUrl?: () => string | null;
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
  private letting: Promise<boolean> | null = null;
  private readonly off: RelayStatus = {
    state: 'off',
    since: Date.now(),
    problem: null,
    lastError: null,
    retryAt: null,
  };

  constructor(private readonly options: RelayOptions) {}

  /** `PMP_RELAY_URL`, or null when this PC never connects. */
  get relayUrl(): string | null {
    return this.options.relayUrl;
  }

  /**
   * The family's relay address while registered: the PC's secure address (ADR 0021). Not
   * while the relay refuses this PC, because the address doesn't reach it then (ADR 0025).
   */
  url(): string | null {
    if (!this.options.relayUrl || this.status().state === 'problem') return null;
    return getRelayRecord(this.options.db)?.url ?? null;
  }

  /** `GET /api/relay` and `relay.changed`: the state, without the secret or kiosk id. */
  info(): RelayInfo {
    const status = this.status();
    const record = this.options.relayUrl ? getRelayRecord(this.options.db) : null;
    return {
      state: status.state,
      url: record?.url ?? null,
      problem: status.problem,
      since: status.since,
      lastError: status.lastError,
      licenceHint: record?.licenceHint ?? null,
      lanUrl: this.options.lanUrl?.() ?? null,
    };
  }

  status(): RelayStatus {
    return this.client?.status ?? this.off;
  }

  /** The client, while one runs (tests look at it). */
  get tunnel(): TunnelClient | null {
    return this.client;
  }

  /** Connects again with the stored registration, even if it hasn't changed ("Try again"). */
  retry(): void {
    this.running = null;
    this.reload();
  }

  /** Resolves once the state isn't `connecting`, or after `maxMs`. */
  async settled(maxMs: number): Promise<void> {
    const until = Date.now() + maxMs;
    while (this.status().state === 'connecting' && Date.now() < until) await pause(50);
  }

  /**
   * Resolves once no phone's HTTP request is in flight on the tunnel, or after `maxMs`: the
   * answer to a phone's own Disconnect must get out before the tunnel goes (ADR 0025).
   */
  async drained(maxMs: number): Promise<void> {
    const until = Date.now() + maxMs;
    while ((this.client?.openHttpStreams ?? 0) > 0 && Date.now() < until) await pause(20);
  }

  /**
   * After Disconnect cleared the registration: once in-flight answers are out, stops the
   * tunnel, then tells the relay to free the licence (best effort). True if it did.
   */
  letGo(record: RelayRecord): Promise<boolean> {
    const run = async () => {
      await this.drained(5_000);
      const old = this.client;
      this.reload();
      await old?.stop();
      const { relayUrl } = this.options;
      return relayUrl ? unregisterFromRelay(relayUrl, record) : false;
    };
    this.letting = run();
    return this.letting;
  }

  /** The last `letGo`, for tests. */
  get lettingGo(): Promise<boolean> | null {
    return this.letting;
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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
