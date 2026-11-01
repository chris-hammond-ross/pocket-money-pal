/**
 * The tunnel client (ADR 0021, ADR 0023): keeps one WebSocket open to the relay's
 * `/connect`, and reconnects after any drop with exponential backoff and jitter. The relay
 * can restart at any time (a deploy, a Durable Object moving): every request on the old
 * connection is abandoned, and the next connection starts clean.
 *
 * Keepalives are the fixed text `TUNNEL_PING`, which the relay answers with `TUNNEL_PONG`
 * through `setWebSocketAutoResponse` without waking its Durable Object. Hearing nothing at
 * all for `silenceLimitMs` means the connection is dead, even if TCP hasn't noticed.
 */
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  tunnelBackoffMs,
  tunnelConnectUrl,
  tunnelProblemOfClose,
  tunnelProblemOfStatus,
  TunnelProtocolError,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_KIOSK_HEADER,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PING,
  TUNNEL_PING_EVERY_MS,
  TUNNEL_PROTOCOL_VERSION,
  TUNNEL_SILENCE_LIMIT_MS,
  TUNNEL_VERSION_HEADER,
  type RelayRecord,
  type TunnelProblem,
} from '@pmp/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import { TunnelSession } from './session';

/** Where the PC stands with the relay (spec 008's `GET /api/relay`). */
export type RelayState = 'off' | 'connecting' | 'connected' | 'problem';

export interface RelayStatus {
  state: RelayState;
  /** When `state` last changed (ms). "Reconnecting…" shows after 30 s of `connecting`. */
  since: number;
  /** Why the relay won't have this PC, while `problem`. */
  problem: TunnelProblem | null;
  /** The last thing that went wrong, while `connecting` again after a drop. */
  lastError: string | null;
  /** When the next attempt starts, while waiting to reconnect. */
  retryAt: number | null;
}

export interface TunnelTiming {
  /** Backoff: the first wait, and the most it grows to. */
  baseMs: number;
  maxMs: number;
  pingEveryMs: number;
  silenceLimitMs: number;
  /** From dialling to `ready`. */
  handshakeMs: number;
  /** A connection that lasted this long starts the backoff again from the beginning. */
  stableAfterMs: number;
}

export const DEFAULT_TUNNEL_TIMING: TunnelTiming = {
  baseMs: 1_000,
  maxMs: 5 * 60_000,
  pingEveryMs: TUNNEL_PING_EVERY_MS,
  silenceLimitMs: TUNNEL_SILENCE_LIMIT_MS,
  handshakeMs: 15_000,
  stableAfterMs: 60_000,
};

export interface TunnelClientOptions {
  app: FastifyInstance;
  /** `PMP_RELAY_URL`. */
  relayUrl: string;
  record: RelayRecord;
  appVersion: string;
  log: FastifyBaseLogger;
  onChange?: (status: RelayStatus) => void;
  timing?: Partial<TunnelTiming>;
  /** For the backoff's jitter (faked in tests). */
  random?: () => number;
}

function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

/**
 * One registration's connection to the relay. `start` once; `stop` for good (the
 * registration changed or was removed, or the server is closing). Real time throughout,
 * never the dev clock.
 */
export class TunnelClient {
  private readonly timing: TunnelTiming;
  private readonly familyUrl: URL;
  private socket: WebSocket | null = null;
  private session: TunnelSession | null = null;
  private retry: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private current: RelayStatus = {
    state: 'off',
    since: Date.now(),
    problem: null,
    lastError: null,
    retryAt: null,
  };

  constructor(private readonly options: TunnelClientOptions) {
    this.timing = { ...DEFAULT_TUNNEL_TIMING, ...options.timing };
    this.familyUrl = new URL(options.record.url);
  }

  get status(): RelayStatus {
    return this.current;
  }

  /** Requests and WebSockets open on the live connection. */
  get openStreams(): number {
    return this.session?.size ?? 0;
  }

  start(): void {
    this.connect();
  }

  /** Closes the connection and stops retrying. Resolves once the socket is closed. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Stopping');
      else socket.terminate();
      await closed;
    }
    this.set({ state: 'off', problem: null, lastError: null, retryAt: null });
  }

  private set(next: Omit<RelayStatus, 'since'>): void {
    const changed =
      next.state !== this.current.state ||
      next.problem !== this.current.problem ||
      next.lastError !== this.current.lastError ||
      next.retryAt !== this.current.retryAt;
    if (!changed) return;
    const since = next.state === this.current.state ? this.current.since : Date.now();
    this.current = { ...next, since };
    this.options.onChange?.(this.current);
  }

  private connect(): void {
    if (this.stopped) return;
    this.retry = null;
    const { record, relayUrl, log } = this.options;
    this.set({ ...this.current, state: 'connecting', problem: null, retryAt: null });

    const socket = new WebSocket(tunnelConnectUrl(relayUrl), {
      headers: {
        authorization: `Bearer ${record.secret}`,
        [TUNNEL_KIOSK_HEADER]: record.kioskId,
        [TUNNEL_VERSION_HEADER]: String(TUNNEL_PROTOCOL_VERSION),
      },
      maxPayload: TUNNEL_MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.socket = socket;

    let refusedWith: number | null = null;
    let error: string | null = null;
    let readyAt: number | null = null;
    let lastHeard = Date.now();
    let session: TunnelSession | null = null;

    const handshake = setTimeout(() => {
      error = 'The relay did not answer in time';
      socket.terminate();
    }, this.timing.handshakeMs);
    let ticker: NodeJS.Timeout | null = null;

    const protocolError = (err: unknown) => {
      log.warn({ err }, 'Relay: protocol error; reconnecting');
      error = 'The relay sent something this PC does not understand';
      socket.close(TUNNEL_CLOSE_PROTOCOL, 'Protocol error');
    };

    socket.on('unexpected-response', (_req, res) => {
      refusedWith = res.statusCode ?? 0;
      res.resume();
      // Aborts the handshake: `error`, then `close`, as for any failed attempt.
      socket.terminate();
    });

    socket.on('open', () => {
      socket.send(
        encodeTunnelFrame({
          type: 'hello',
          version: TUNNEL_PROTOCOL_VERSION,
          appVersion: this.options.appVersion.slice(0, 64),
        }),
      );
      ticker = setInterval(() => {
        if (Date.now() - lastHeard > this.timing.silenceLimitMs) {
          error = 'The relay stopped answering';
          socket.terminate();
        } else socket.send(TUNNEL_PING);
      }, this.timing.pingEveryMs);
    });

    socket.on('message', (data, isBinary) => {
      lastHeard = Date.now();
      if (!isBinary) return; // TUNNEL_PONG: hearing it is all that matters
      let frame;
      try {
        frame = decodeTunnelFrame(bytesOf(data));
      } catch (err) {
        return protocolError(err);
      }
      if (!session) {
        if (frame.type !== 'ready') return protocolError(`${frame.type} before ready`);
        clearTimeout(handshake);
        readyAt = Date.now();
        session = new TunnelSession({
          app: this.options.app,
          familyUrl: this.familyUrl,
          log,
          send: (bytes) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
          },
        });
        this.session = session;
        log.info({ url: record.url }, 'Relay: connected');
        this.set({ state: 'connected', problem: null, lastError: null, retryAt: null });
        return;
      }
      try {
        session.handle(frame);
      } catch (err) {
        if (err instanceof TunnelProtocolError) return protocolError(err);
        throw err;
      }
    });

    socket.on('error', (err) => {
      error ??= err.message;
    });

    socket.on('close', (code, reason) => {
      clearTimeout(handshake);
      if (ticker) clearInterval(ticker);
      session?.close();
      if (this.session === session) this.session = null;
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;

      const problem =
        refusedWith !== null ? tunnelProblemOfStatus(refusedWith) : tunnelProblemOfClose(code);
      if (problem) {
        log.warn({ problem }, 'Relay: refused; not retrying');
        this.set({ state: 'problem', problem, lastError: null, retryAt: null });
        return;
      }
      if (readyAt !== null) {
        log.info({ code, reason: reason.toString('utf8') }, 'Relay: disconnected');
        if (Date.now() - readyAt >= this.timing.stableAfterMs) this.attempt = 0;
      }
      const delay = tunnelBackoffMs(this.attempt++, this.options.random ?? Math.random, {
        baseMs: this.timing.baseMs,
        maxMs: this.timing.maxMs,
      });
      const lastError =
        refusedWith !== null
          ? `The relay answered ${refusedWith}`
          : (error ?? `Connection closed (${code}${reason.length ? ` ${reason}` : ''})`);
      this.set({ state: 'connecting', problem: null, lastError, retryAt: Date.now() + delay });
      this.retry = setTimeout(() => this.connect(), delay);
      this.retry.unref();
    });
  }
}
