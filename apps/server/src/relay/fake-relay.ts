/**
 * A tiny stand-in for the relay (the private repo's Worker and Durable Object), for tests
 * and `npm run relay:fake`. It speaks the tunnel protocol the same way: the PC connects to
 * `/connect`, pings are answered with a fixed pong (as `setWebSocketAutoResponse` does),
 * and every other request or WebSocket on the port is a phone's, carried over the tunnel
 * with the same credit windows. Not part of the server bundle.
 */
import { EventEmitter } from 'node:events';
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  normaliseLicenceKey,
  TunnelReceiveWindow,
  TunnelSendWindow,
  TUNNEL_CHUNK_BYTES,
  TUNNEL_CLOSE_REPLACED,
  TUNNEL_CONNECT_PATH,
  TUNNEL_HOP_BY_HOP,
  TUNNEL_KIOSK_HEADER,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PING,
  TUNNEL_PONG,
  TUNNEL_PROBLEM_STATUS,
  TUNNEL_PROTOCOL_VERSION,
  TUNNEL_VERSION_HEADER,
  type TunnelFrame,
  type TunnelFrameOf,
  type TunnelHeaders,
} from '@pmp/shared';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export interface FakeRelayOptions {
  kioskId?: string;
  secret?: string;
  /** 0 (the default) picks a free port. */
  port?: number;
  host?: string;
  /** The licence `/register` accepts. */
  licenceKey?: string;
}

interface PhoneRequest {
  res: ServerResponse;
  send: TunnelSendWindow;
  receive: TunnelReceiveWindow;
}

interface PhoneSocket {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  ws: WebSocket | null;
}

function pairsOf(raw: string[]): TunnelHeaders {
  const pairs: TunnelHeaders = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (!TUNNEL_HOP_BY_HOP.has(raw[i]!.toLowerCase())) pairs.push([raw[i]!, raw[i + 1]!]);
  }
  return pairs;
}

function clientIpOf(req: IncomingMessage): string {
  const ip = req.socket.remoteAddress ?? '127.0.0.1';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function bytesOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

function refuse(socket: Duplex, status: number, body: object = {}): void {
  const json = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
  );
}

/**
 * Events: `connect` (each `/connect` attempt, with its headers), `pc` (a PC said hello and
 * got `ready`), `pc-gone`, `frame` (every frame from the PC), `ping`.
 */
export class FakeRelay extends EventEmitter {
  readonly kioskId: string;
  readonly secret: string;
  /** Answer `/connect` with this status instead (a refused licence, a relay that's down). */
  refuseWith: number | null = null;
  /** Answer pings, as `setWebSocketAutoResponse` does. Off: a relay gone silent. */
  answerPings = true;
  /** Send credit as phones take a response (off: a phone that stopped reading). */
  autoCredit = true;
  /** The PC's last `hello`. */
  hello: TunnelFrameOf<'hello'> | null = null;
  pings = 0;
  /** The licence `/register` accepts. */
  readonly licenceKey: string;
  /** Another PC has the licence: `/register` answers 409 unless it takes over. */
  inUse = false;
  /** Answer `/register` with this instead (`{ status, error }`, or `null` for no JSON). */
  registerAnswer: { status: number; error: string | null } | null = null;
  /** The bodies `/register` was sent, and the `/unregister` calls that were let through. */
  readonly registered: { licenceKey: string; takeOver?: boolean; version: string | null }[] = [];
  unregistered = 0;

  private readonly server = createServer((req, res) => this.phoneRequest(req, res));
  private readonly pcServer = new WebSocketServer({
    noServer: true,
    maxPayload: TUNNEL_MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  private readonly phoneServer = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<Socket>();
  private pc: WebSocket | null = null;
  private nextStream = 1;
  private readonly requests = new Map<number, PhoneRequest>();
  private readonly phones = new Map<number, PhoneSocket>();
  private port: number;

  constructor(private readonly options: FakeRelayOptions = {}) {
    super();
    this.kioskId = options.kioskId ?? 'fakefamily';
    this.secret = options.secret ?? 'fake-relay-secret';
    this.licenceKey = options.licenceKey ?? 'PMP-FAKE2-FAKE3-FAKE4-FAKE5';
    this.port = options.port ?? 0;
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  /** `PMP_RELAY_URL` for a server using this relay. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The family's address, as a browser on this machine opens it. */
  get familyUrl(): string {
    return `http://${this.kioskId}.localhost:${this.port}`;
  }

  /** The registration a PC needs to connect here. */
  get record() {
    return { kioskId: this.kioskId, secret: this.secret, url: this.familyUrl, licenceHint: 'FAKE' };
  }

  get connected(): boolean {
    return this.pc !== null && this.hello !== null;
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) =>
      this.server.listen(this.port, this.options.host ?? '127.0.0.1', resolve),
    );
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  /** Stops listening and drops everything, as a relay restart does. */
  async close(): Promise<void> {
    this.pc?.terminate();
    for (const phone of this.phones.values()) phone.ws?.terminate();
    for (const socket of this.sockets) socket.destroy();
    this.pcServer.close();
    this.phoneServer.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Closes the PC's connection with `code`, as a relay restart (1001) or a refusal does. */
  dropPc(code = 1001, reason = ''): void {
    this.pc?.close(code, reason);
  }

  /** Sends a frame to the PC, for tests that drive the protocol by hand. */
  sendToPc(frame: TunnelFrame): void {
    if (this.pc?.readyState === this.pc?.OPEN) this.pc?.send(encodeTunnelFrame(frame));
  }

  /** A fresh stream id, for frames sent by hand. */
  openStream(): number {
    return this.nextStream++;
  }

  /** The next frame from the PC that `match`es. */
  nextFrame<T extends TunnelFrame>(match: (f: TunnelFrame) => f is T): Promise<T>;
  nextFrame(match: (f: TunnelFrame) => boolean): Promise<TunnelFrame>;
  nextFrame(match: (f: TunnelFrame) => boolean): Promise<TunnelFrame> {
    return new Promise((resolve) => {
      const listener = (frame: TunnelFrame) => {
        if (!match(frame)) return;
        this.off('frame', listener);
        resolve(frame);
      };
      this.on('frame', listener);
    });
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    if (path === TUNNEL_CONNECT_PATH) return this.pcUpgrade(req, socket, head);
    return this.phoneUpgrade(req, socket, head);
  }

  private pcUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.emit('connect', req.headers);
    const ok =
      req.headers.authorization === `Bearer ${this.secret}` &&
      req.headers[TUNNEL_KIOSK_HEADER] === this.kioskId;
    const status =
      this.refuseWith ??
      (!ok
        ? TUNNEL_PROBLEM_STATUS['bad-secret']
        : Number(req.headers[TUNNEL_VERSION_HEADER]) !== TUNNEL_PROTOCOL_VERSION
          ? TUNNEL_PROBLEM_STATUS['update-needed']
          : null);
    if (status !== null) return refuse(socket, status, { error: 'refused' });

    this.pcServer.handleUpgrade(req, socket, head, (ws) => {
      // One connection per PC: a newer one replaces the old, as the Durable Object does.
      if (this.pc) {
        this.pc.close(TUNNEL_CLOSE_REPLACED, 'Replaced');
        this.pcGone();
      }
      this.pc = ws;
      this.hello = null;
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          if (data.toString() === TUNNEL_PING) {
            this.pings++;
            this.emit('ping');
            if (this.answerPings) ws.send(TUNNEL_PONG);
          }
          return;
        }
        const frame = decodeTunnelFrame(bytesOf(data));
        this.emit('frame', frame);
        this.fromPc(frame);
      });
      ws.on('close', () => {
        if (this.pc !== ws) return;
        this.pc = null;
        this.pcGone();
      });
    });
  }

  /** The PC's connection ended: every phone on it gets an error, as from the real relay. */
  private pcGone(): void {
    this.hello = null;
    for (const [id, { res }] of this.requests) {
      this.requests.delete(id);
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"pc-gone"}');
    }
    for (const [id, phone] of this.phones) {
      this.phones.delete(id);
      if (phone.ws) phone.ws.close(1012, 'PC reconnecting');
      else refuse(phone.socket, 502);
    }
    this.emit('pc-gone');
  }

  private fromPc(frame: TunnelFrame): void {
    switch (frame.type) {
      case 'hello':
        this.hello = frame;
        this.sendToPc({ type: 'ready', version: TUNNEL_PROTOCOL_VERSION });
        this.emit('pc');
        return;
      case 'res': {
        const r = this.requests.get(frame.stream);
        r?.res.writeHead(frame.status, frame.headers.flat());
        if (frame.end) this.finishRequest(frame.stream);
        return;
      }
      case 'data': {
        const r = this.requests.get(frame.stream);
        if (!r) return;
        r.receive.receive(frame.data.length);
        const n = frame.data.length;
        r.res.write(frame.data, () => {
          if (!this.autoCredit) return;
          const credit = r.receive.consume(n);
          if (credit > 0) this.sendToPc({ type: 'credit', stream: frame.stream, bytes: credit });
        });
        return;
      }
      case 'end':
        return this.finishRequest(frame.stream);
      case 'credit':
        this.requests.get(frame.stream)?.send.grant(frame.bytes);
        return;
      case 'reset': {
        const r = this.requests.get(frame.stream);
        if (!r) return;
        this.requests.delete(frame.stream);
        r.send.close();
        const status = frame.code === 'too-big' ? 413 : 502;
        if (r.res.headersSent) r.res.destroy();
        else {
          r.res.writeHead(status, { 'content-type': 'application/json' });
          r.res.end(JSON.stringify({ error: frame.code }));
        }
        return;
      }
      case 'ws-accept': {
        const phone = this.phones.get(frame.stream);
        if (!phone) return;
        this.phoneServer.handleUpgrade(phone.req, phone.socket, phone.head, (ws) => {
          phone.ws = ws;
          ws.on('message', (data, isBinary) =>
            this.sendToPc({
              type: 'ws-msg',
              stream: frame.stream,
              text: !isBinary,
              data: bytesOf(data),
            }),
          );
          ws.on('close', (code, reason) => {
            if (!this.phones.delete(frame.stream)) return;
            const sendable = code === 1005 || code === 1006 ? 1000 : code;
            this.sendToPc({
              type: 'ws-close',
              stream: frame.stream,
              code: sendable,
              reason: reason.toString(),
            });
          });
        });
        return;
      }
      case 'ws-reject': {
        const phone = this.phones.get(frame.stream);
        this.phones.delete(frame.stream);
        if (phone) refuse(phone.socket, frame.status);
        return;
      }
      case 'ws-msg':
        this.phones.get(frame.stream)?.ws?.send(frame.data, { binary: !frame.text });
        return;
      case 'ws-close': {
        const phone = this.phones.get(frame.stream);
        this.phones.delete(frame.stream);
        phone?.ws?.close(frame.code, frame.reason);
        return;
      }
    }
  }

  /** `POST /register`, as ADR 0024 describes it. The address and secret stay the same. */
  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const answer = (status: number, body: object): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    let body: { licenceKey?: unknown; takeOver?: unknown } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
    } catch {
      return answer(400, { error: 'bad-request' });
    }
    const licenceKey = typeof body.licenceKey === 'string' ? body.licenceKey : '';
    const takeOver = body.takeOver === true;
    const version = req.headers[TUNNEL_VERSION_HEADER];
    this.registered.push({
      licenceKey,
      ...(takeOver && { takeOver }),
      version: typeof version === 'string' ? version : null,
    });
    if (this.registerAnswer) {
      const { status, error } = this.registerAnswer;
      if (error === null) return void res.writeHead(status).end('not json');
      return answer(status, { error });
    }
    if (normaliseLicenceKey(licenceKey) !== normaliseLicenceKey(this.licenceKey)) {
      return answer(404, { error: 'unknown-licence' });
    }
    if (this.inUse && !takeOver) return answer(409, { error: 'licence-in-use' });
    this.inUse = true;
    return answer(200, { kioskId: this.kioskId, secret: this.secret, url: this.familyUrl });
  }

  /** `POST /unregister` with the PC's upgrade headers: the licence is free again. */
  private unregister(req: IncomingMessage, res: ServerResponse): void {
    const ok =
      req.headers.authorization === `Bearer ${this.secret}` &&
      req.headers[TUNNEL_KIOSK_HEADER] === this.kioskId;
    if (!ok) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad-secret"}');
      return;
    }
    this.unregistered++;
    this.inUse = false;
    this.pc?.close(4401, 'Unregistered');
    res.writeHead(204).end();
  }

  private finishRequest(id: number): void {
    const r = this.requests.get(id);
    this.requests.delete(id);
    r?.send.close();
    r?.res.end();
  }

  private async phoneRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The relay's own routes (the real one only has them on its apex).
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    if (req.method === 'POST' && path === '/register') return this.register(req, res);
    if (req.method === 'POST' && path === '/unregister') return this.unregister(req, res);
    if (!this.connected) {
      const page = !req.url?.startsWith('/api');
      res.writeHead(503, { 'content-type': page ? 'text/html' : 'application/json' });
      res.end(page ? '<h1>Your family PC is off or offline</h1>' : '{"error":"pc-offline"}');
      return;
    }
    const id = this.nextStream++;
    const entry: PhoneRequest = {
      res,
      send: new TunnelSendWindow(),
      receive: new TunnelReceiveWindow(),
    };
    this.requests.set(id, entry);
    const length = Number(req.headers['content-length'] ?? 0);
    const hasBody = length > 0 || req.headers['transfer-encoding'] !== undefined;
    this.sendToPc({
      type: 'req',
      stream: id,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: pairsOf(req.rawHeaders),
      clientIp: clientIpOf(req),
      end: !hasBody,
    });
    res.on('close', () => {
      if (!this.requests.delete(id)) return;
      entry.send.close();
      this.sendToPc({ type: 'reset', stream: id, code: 'cancelled' });
    });
    if (!hasBody) return;
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        for (let at = 0; at < chunk.length;) {
          await entry.send.ready();
          const n = Math.min(chunk.length - at, TUNNEL_CHUNK_BYTES, entry.send.available);
          entry.send.take(n);
          this.sendToPc({ type: 'data', stream: id, data: chunk.subarray(at, at + n) });
          at += n;
        }
      }
      this.sendToPc({ type: 'end', stream: id });
    } catch {
      // The stream was closed (the PC answered early, or went away).
    }
  }

  private phoneUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.connected) return refuse(socket, 503, { error: 'pc-offline' });
    const id = this.nextStream++;
    this.phones.set(id, { req, socket, head, ws: null });
    this.sendToPc({
      type: 'ws-open',
      stream: id,
      path: req.url ?? '/',
      headers: pairsOf(req.rawHeaders),
      clientIp: clientIpOf(req),
    });
  }
}
