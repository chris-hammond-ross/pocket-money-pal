/**
 * One live tunnel connection's streams (ADR 0021, ADR 0023). A phone's HTTP request runs
 * through `app.inject` and its WebSocket through `app.injectWS`, both marked tunnelled
 * (`tunnelledHeaders()`), so the remote guard (ADR 0022) treats them like any request from
 * outside: paired phones only, `Origin` checked, rate limits by the phone's address.
 */
import { Readable } from 'node:stream';
import {
  encodeTunnelFrame,
  TunnelProtocolError,
  TunnelReceiveWindow,
  TunnelSendWindow,
  TUNNEL_CHUNK_BYTES,
  TUNNEL_HOP_BY_HOP,
  TUNNEL_MAX_BODY_BYTES,
  TUNNEL_MAX_STREAMS,
  WS_PATH,
  type TunnelFrame,
  type TunnelFrameOf,
  type TunnelHeaders,
  type TunnelResetCode,
} from '@pmp/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { tunnelledHeaders } from '../net';

/**
 * Headers the relay's request may not carry through: the PC says itself who asked and
 * how the phone reached it, the way `tailscale serve` does (ADR 0022).
 */
const PROXY_HEADER =
  /^(host|forwarded|via|x-forwarded-.*|x-real-ip|true-client-ip|cf-.*|x-pmp-.*)$/;

/**
 * The phone's headers as an injected request should see them: from `127.0.0.1`, with
 * `X-Forwarded-For` the phone's address and `-Proto` and `-Host` the family's address, so
 * `req.ip`, `req.protocol` and `req.host` come out as the phone saw them. The tunnel's mark
 * goes last, over anything the relay sent.
 */
export function injectedHeaders(
  pairs: TunnelHeaders,
  clientIp: string,
  familyUrl: URL,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [raw, value] of pairs) {
    const name = raw.toLowerCase();
    if (TUNNEL_HOP_BY_HOP.has(name) || PROXY_HEADER.test(name)) continue;
    const before = headers[name];
    headers[name] =
      before === undefined ? value : `${before}${name === 'cookie' ? '; ' : ', '}${value}`;
  }
  return {
    ...headers,
    host: familyUrl.host,
    'x-forwarded-for': clientIp,
    'x-forwarded-proto': familyUrl.protocol.replace(/:$/, ''),
    'x-forwarded-host': familyUrl.host,
    ...tunnelledHeaders(),
  };
}

/** A response's headers as pairs, repeated ones (`set-cookie`) kept apart. */
export function responseHeaders(headers: Record<string, unknown>): TunnelHeaders {
  const pairs: TunnelHeaders = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || TUNNEL_HOP_BY_HOP.has(name.toLowerCase())) continue;
    for (const v of Array.isArray(value) ? value : [value]) pairs.push([name, String(v)]);
  }
  return pairs;
}

/** A WebSocket close code that may be sent again (1005, 1006 and 1015 are only ever reported). */
function sendableCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) return code;
  return 1000;
}

function bytesOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

class TooBig extends Error {}

/** One phone request: its body coming in, the PC's answer going out. */
class HttpStream {
  private readonly sendWindow = new TunnelSendWindow();
  private readonly receiveWindow = new TunnelReceiveWindow();
  private readonly abort = new AbortController();
  /** The request body, fed by `data` frames. Null when the request has none. */
  private body: Readable | null = null;
  private bodyEnded = false;
  /** Body bytes pushed into `body`, and how many of them were already handed to `consume`. */
  private pushed = 0;
  private accounted = 0;
  private response: Readable | null = null;
  private closed = false;

  constructor(
    private readonly session: TunnelSession,
    readonly id: number,
  ) {}

  start(req: TunnelFrameOf<'req'>): void {
    if (!req.end) {
      this.body = new Readable({ highWaterMark: TUNNEL_CHUNK_BYTES, read: () => this.credit() });
    }
    void this.run(req);
  }

  /** Credits back what the request has read of its body so far. */
  private credit(): void {
    if (!this.body || this.closed) return;
    const consumed = this.pushed - this.body.readableLength;
    const credit = this.receiveWindow.consume(consumed - this.accounted);
    this.accounted = consumed;
    if (credit > 0) this.session.send({ type: 'credit', stream: this.id, bytes: credit });
  }

  data(bytes: Uint8Array): void {
    if (!this.body || this.bodyEnded) return this.fail('protocol');
    try {
      this.receiveWindow.receive(bytes.length);
    } catch {
      return this.fail('protocol');
    }
    this.pushed += bytes.length;
    if (this.pushed > TUNNEL_MAX_BODY_BYTES) return this.fail('too-big');
    this.body.push(asBuffer(bytes));
  }

  end(): void {
    if (!this.body || this.bodyEnded) return this.fail('protocol');
    this.bodyEnded = true;
    this.body.push(null);
  }

  grant(bytes: number): void {
    this.sendWindow.grant(bytes);
  }

  /** The relay gave up on it (the phone went away), or the tunnel dropped. */
  cancel(): void {
    this.close();
  }

  private fail(code: TunnelResetCode): void {
    if (this.closed) return;
    this.session.send({ type: 'reset', stream: this.id, code });
    this.close();
  }

  /** `abandon`: the request is cut short, so inject is told to stop as well. */
  private close(abandon = true): void {
    if (this.closed) return;
    this.closed = true;
    if (abandon) this.abort.abort();
    this.sendWindow.close();
    this.body?.destroy();
    this.response?.destroy();
    this.session.forget(this.id);
  }

  private async run(req: TunnelFrameOf<'req'>): Promise<void> {
    let res;
    try {
      res = await this.session.app.inject({
        method: req.method as 'GET',
        url: req.path,
        headers: injectedHeaders(req.headers, req.clientIp, this.session.familyUrl),
        remoteAddress: '127.0.0.1',
        payload: this.body ?? undefined,
        payloadAsStream: true,
        signal: this.abort.signal,
      });
    } catch (err) {
      if (!this.closed) this.session.log.warn({ err, path: req.path }, 'Relay: request failed');
      return this.fail('pc-error');
    }
    const stream = res.stream();
    this.response = stream;
    if (this.closed) {
      stream.destroy();
      return;
    }
    this.session.send({
      type: 'res',
      stream: this.id,
      status: res.statusCode,
      headers: responseHeaders(res.headers),
      end: false,
    });
    try {
      let sent = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        sent += chunk.length;
        if (sent > TUNNEL_MAX_BODY_BYTES) throw new TooBig();
        for (let at = 0; at < chunk.length;) {
          await this.sendWindow.ready();
          if (this.closed) return;
          const n = Math.min(chunk.length - at, TUNNEL_CHUNK_BYTES, this.sendWindow.available);
          this.sendWindow.take(n);
          this.session.send({ type: 'data', stream: this.id, data: chunk.subarray(at, at + n) });
          at += n;
        }
      }
      if (this.closed) return;
      this.session.send({ type: 'end', stream: this.id });
      this.close(false);
    } catch (err) {
      if (this.closed) return;
      if (!(err instanceof TooBig)) {
        this.session.log.warn({ err, path: req.path }, 'Relay: response failed');
      }
      this.fail(err instanceof TooBig ? 'too-big' : 'pc-error');
    }
  }
}

/** One phone WebSocket, bridged into the hub through `app.injectWS`. */
class WsBridge {
  private socket: WebSocket | null = null;
  private closed = false;

  constructor(
    private readonly session: TunnelSession,
    readonly id: number,
  ) {}

  async open(frame: TunnelFrameOf<'ws-open'>): Promise<void> {
    if (new URL(frame.path, 'http://pc').pathname !== WS_PATH) return this.reject(404);
    // The hub greets a socket the moment it's added, before `injectWS` resolves, so the
    // listeners go on first and anything said before `ws-accept` is sent waits for it.
    let accepted = false;
    const early: TunnelFrameOf<'ws-msg'>[] = [];
    const onInit = (socket: WebSocket) => {
      socket.on('message', (data, isBinary) => {
        const bytes = bytesOf(data);
        if (bytes.length > TUNNEL_CHUNK_BYTES) return socket.close(1009, 'Message too big');
        const msg = { type: 'ws-msg', stream: this.id, text: !isBinary, data: bytes } as const;
        if (accepted) this.session.send(msg);
        else early.push(msg);
      });
      socket.on('close', (code, reason) => {
        if (!accepted) return;
        if (!this.closed) {
          this.session.send({
            type: 'ws-close',
            stream: this.id,
            code: sendableCloseCode(code),
            reason: reason.toString('utf8').slice(0, 100),
          });
        }
        this.finish();
      });
    };
    let socket: WebSocket;
    try {
      // The upgrade goes through Fastify's routing, so the remote guard checks the paired
      // cookie and the `Origin` itself (9.1). The fake socket says "from loopback", so
      // `X-Forwarded-For` is believed, as from any local proxy.
      socket = await this.session.app.injectWS(
        frame.path,
        {
          socket: { remoteAddress: '127.0.0.1' },
          headers: injectedHeaders(frame.headers, frame.clientIp, this.session.familyUrl),
        } as never,
        { onInit },
      );
    } catch (err) {
      // `injectWS` rejects with "Unexpected server response: 401" when the guard refuses.
      const status = Number(/server response: ([45]\d\d)/.exec(String(err))?.[1] ?? 502);
      return this.reject(status);
    }
    if (this.closed) {
      socket.terminate();
      return;
    }
    this.socket = socket;
    this.session.send({ type: 'ws-accept', stream: this.id });
    accepted = true;
    for (const msg of early.splice(0)) this.session.send(msg);
    if (socket.readyState !== socket.OPEN) this.closeFromRelay();
  }

  /** A message from the phone. */
  message(frame: TunnelFrameOf<'ws-msg'>): void {
    this.socket?.send(asBuffer(frame.data), { binary: !frame.text });
  }

  /**
   * The phone closed, or the relay lost it. Terminated rather than closed: `injectWS`'s
   * in-memory socket never finishes a closing handshake, so the hub would keep it for
   * ws's 30-second close timeout. The hub doesn't care how a socket ended.
   */
  closeFromRelay(): void {
    if (this.closed) return;
    this.finish();
    this.socket?.terminate();
  }

  /** The tunnel dropped. */
  cancel(): void {
    if (this.closed) return;
    this.finish();
    this.socket?.terminate();
  }

  private reject(status: number): void {
    if (this.closed) return;
    this.session.send({ type: 'ws-reject', stream: this.id, status });
    this.finish();
  }

  private finish(): void {
    this.closed = true;
    this.session.forget(this.id);
  }
}

export interface TunnelSessionOptions {
  app: FastifyInstance;
  /** Sends one encoded frame to the relay. */
  send: (bytes: Uint8Array) => void;
  /** The family's address as phones see it (the registration's `url`). */
  familyUrl: URL;
  log: FastifyBaseLogger;
}

/**
 * The streams on one live connection. `handle` each frame after `ready`; `close` when the
 * connection drops, which abandons every request and WebSocket on it.
 */
export class TunnelSession {
  readonly app: FastifyInstance;
  readonly familyUrl: URL;
  readonly log: FastifyBaseLogger;
  private readonly streams = new Map<number, HttpStream | WsBridge>();
  private closed = false;

  constructor(private readonly options: TunnelSessionOptions) {
    this.app = options.app;
    this.familyUrl = options.familyUrl;
    this.log = options.log;
  }

  /** Streams open now. */
  get size(): number {
    return this.streams.size;
  }

  /** HTTP requests in flight (a phone's WebSocket stays open, so it isn't counted). */
  get httpSize(): number {
    let n = 0;
    for (const stream of this.streams.values()) if (stream instanceof HttpStream) n++;
    return n;
  }

  send(frame: TunnelFrame): void {
    if (!this.closed) this.options.send(encodeTunnelFrame(frame));
  }

  forget(id: number): void {
    this.streams.delete(id);
  }

  /** Throws `TunnelProtocolError` for a frame that can't be right: the connection is closed. */
  handle(frame: TunnelFrame): void {
    if (this.closed) return;
    switch (frame.type) {
      case 'req':
      case 'ws-open':
        return this.open(frame);
      case 'data':
      case 'end':
      case 'credit':
      case 'reset': {
        // A stream that just finished can still get a late credit or reset: not an error.
        const stream = this.streams.get(frame.stream);
        if (!(stream instanceof HttpStream)) return;
        if (frame.type === 'data') return stream.data(frame.data);
        if (frame.type === 'end') return stream.end();
        if (frame.type === 'credit') return stream.grant(frame.bytes);
        return stream.cancel();
      }
      case 'ws-msg':
      case 'ws-close': {
        const bridge = this.streams.get(frame.stream);
        if (!(bridge instanceof WsBridge)) return;
        if (frame.type === 'ws-msg') return bridge.message(frame);
        return bridge.closeFromRelay();
      }
      default:
        throw new TunnelProtocolError(`the relay sent ${frame.type}`);
    }
  }

  private open(frame: TunnelFrameOf<'req'> | TunnelFrameOf<'ws-open'>): void {
    if (this.streams.has(frame.stream)) {
      throw new TunnelProtocolError(`stream ${frame.stream} is already open`);
    }
    if (this.streams.size >= TUNNEL_MAX_STREAMS) {
      if (frame.type === 'req') {
        this.send({ type: 'reset', stream: frame.stream, code: 'too-many-streams' });
      } else this.send({ type: 'ws-reject', stream: frame.stream, status: 503 });
      return;
    }
    if (frame.type === 'req') {
      const stream = new HttpStream(this, frame.stream);
      this.streams.set(frame.stream, stream);
      stream.start(frame);
    } else {
      const bridge = new WsBridge(this, frame.stream);
      this.streams.set(frame.stream, bridge);
      void bridge.open(frame);
    }
  }

  /** The connection dropped: every stream on it is abandoned. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of [...this.streams.values()]) stream.cancel();
    this.streams.clear();
  }
}
