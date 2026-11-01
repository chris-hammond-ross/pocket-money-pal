/**
 * The tunnel protocol between the family PC and the relay (ADR 0021, ADR 0023). The PC
 * dials out to `<relay>/connect` and keeps one WebSocket open. The relay carries phones'
 * HTTP requests and WebSockets over it as numbered streams.
 *
 * Every frame is one binary WebSocket message:
 *
 *     [type: u8][stream: u32][meta length: u32][meta: UTF-8 JSON][body bytes]
 *
 * Stream 0 is the connection itself (`hello`, `ready`). Only the relay opens streams. The
 * only text messages are the keepalive pair `TUNNEL_PING` → `TUNNEL_PONG`, so a hibernating
 * Durable Object answers them with `setWebSocketAutoResponse` without waking.
 *
 * Plain TypeScript, `Uint8Array`, `DataView` and `TextEncoder` only: the relay (a
 * Cloudflare Worker) imports this file unchanged, so no Node Buffers or streams here.
 */
import { z } from 'zod';

/** Sent in the upgrade (`TUNNEL_VERSION_HEADER`) and in `hello`. The relay accepts this one and the one before. */
export const TUNNEL_PROTOCOL_VERSION = 1;

/** Where the PC connects, on the relay's apex domain. */
export const TUNNEL_CONNECT_PATH = '/connect';
/** Upgrade headers. The secret goes in `Authorization: Bearer <secret>`. */
export const TUNNEL_KIOSK_HEADER = 'x-pmp-kiosk';
export const TUNNEL_VERSION_HEADER = 'x-pmp-tunnel-version';

/** The keepalive: the PC sends this text message, and the relay answers with `TUNNEL_PONG`. */
export const TUNNEL_PING = 'pmp-ping';
export const TUNNEL_PONG = 'pmp-pong';
/** How often the PC pings, and how long it waits to hear anything before giving up. */
export const TUNNEL_PING_EVERY_MS = 30_000;
export const TUNNEL_SILENCE_LIMIT_MS = 75_000;

/** The most body bytes in one `data` or `ws-msg` frame. */
export const TUNNEL_CHUNK_BYTES = 64 * 1024;
/** Per stream and direction, the body bytes a sender may have sent and not had credited. */
export const TUNNEL_WINDOW_BYTES = 1024 * 1024;
/** The biggest request or response body. A 100 MB backup restore (ADR 0020) fits. */
export const TUNNEL_MAX_BODY_BYTES = 110 * 1024 * 1024;
/** The biggest JSON meta in a frame (headers, mostly). */
export const TUNNEL_MAX_META_BYTES = 64 * 1024;
/** The biggest frame either side sends, well under a Worker's 1 MiB message limit. */
export const TUNNEL_MAX_FRAME_BYTES = 9 + TUNNEL_MAX_META_BYTES + TUNNEL_CHUNK_BYTES;
/** Streams (HTTP and WebSocket together) open at once on one connection. */
export const TUNNEL_MAX_STREAMS = 64;

/**
 * Why the relay won't have this PC. Each stops the PC retrying until a parent acts (spec
 * 008's Problem state). Anything else (a relay restart, a network blip) is retried.
 */
export const tunnelProblemSchema = z.enum([
  'bad-secret',
  'licence-expired',
  'licence-revoked',
  'moved',
  'update-needed',
]);
export type TunnelProblem = z.infer<typeof tunnelProblemSchema>;

/** The HTTP status the relay answers `/connect` with, for each problem. */
export const TUNNEL_PROBLEM_STATUS: Record<TunnelProblem, number> = {
  'bad-secret': 401,
  'licence-expired': 402,
  'licence-revoked': 403,
  moved: 409,
  'update-needed': 426,
};

/** The close code the relay ends a live connection with, for each problem. */
export const TUNNEL_PROBLEM_CLOSE: Record<TunnelProblem, number> = {
  'bad-secret': 4401,
  'licence-expired': 4402,
  'licence-revoked': 4403,
  moved: 4409,
  'update-needed': 4426,
};

/** What the relay's `/register` answers (ADR 0021): who the PC is, and the family's address. */
export const tunnelRegistrationSchema = z.object({
  kioskId: z.string().min(1).max(64),
  secret: z.string().min(1).max(512),
  /** e.g. `https://k7qm4pxd2r.pocketmoneypal.app`. */
  url: z.url({ protocol: /^https?$/ }).max(2000),
});
export type TunnelRegistration = z.infer<typeof tunnelRegistrationSchema>;

/**
 * The PC's stored registration (`server_kv` key `relay`, spec 008): never in a backup,
 * never taken from a restore. `licenceHint` is the key's last four characters.
 */
export const relayRecordSchema = tunnelRegistrationSchema.extend({
  licenceHint: z.string().max(8),
});
export type RelayRecord = z.infer<typeof relayRecordSchema>;

/** Close code for a frame that breaks the protocol. The PC reconnects. */
export const TUNNEL_CLOSE_PROTOCOL = 4000;
/** Close code for a connection a newer one from the same PC replaced. */
export const TUNNEL_CLOSE_REPLACED = 4012;

function problemOf(table: Record<TunnelProblem, number>, value: number): TunnelProblem | null {
  const found = Object.entries(table).find(([, v]) => v === value);
  return found ? (found[0] as TunnelProblem) : null;
}

/** The problem behind a refused `/connect`, or null if it's worth retrying (a 5xx, say). */
export function tunnelProblemOfStatus(status: number): TunnelProblem | null {
  return problemOf(TUNNEL_PROBLEM_STATUS, status);
}

/** The problem behind a close code, or null if it's worth reconnecting. */
export function tunnelProblemOfClose(code: number): TunnelProblem | null {
  return problemOf(TUNNEL_PROBLEM_CLOSE, code);
}

/** Why a stream was abandoned (`reset`). */
export const tunnelResetCodeSchema = z.enum([
  /** The phone went away, or the PC gave up on the request. */
  'cancelled',
  /** A body went over `TUNNEL_MAX_BODY_BYTES`. */
  'too-big',
  /** More than `TUNNEL_MAX_STREAMS` at once. */
  'too-many-streams',
  /** The stream broke the protocol (a duplicate id, data past the window). */
  'protocol',
  /** The PC couldn't answer. The relay answers the phone 502. */
  'pc-error',
]);
export type TunnelResetCode = z.infer<typeof tunnelResetCodeSchema>;

/** Headers as `[name, value]` pairs in order, so repeated ones (`set-cookie`) survive. */
export type TunnelHeaders = [string, string][];

const headersSchema = z
  .array(z.tuple([z.string().min(1).max(256), z.string().max(16 * 1024)]))
  .max(200);
const pathSchema = z
  .string()
  .max(8 * 1024)
  .regex(/^\/[^\s]*$/, 'a path starting with /');
const clientIpSchema = z.union([z.ipv4(), z.ipv6()]);
const streamMeta = {
  hello: z.object({ version: z.int().min(1), appVersion: z.string().max(64) }),
  ready: z.object({ version: z.int().min(1) }),
  /** A phone's HTTP request. Unless `end`, its body follows as `data` frames, then `end`. */
  req: z.object({
    method: z.string().regex(/^[A-Z]{1,16}$/),
    path: pathSchema,
    headers: headersSchema,
    clientIp: clientIpSchema,
    end: z.boolean(),
  }),
  /** The PC's answer. Unless `end`, its body follows as `data` frames, then `end`. */
  res: z.object({ status: z.int().min(100).max(599), headers: headersSchema, end: z.boolean() }),
  data: z.object({}),
  end: z.object({}),
  /** The receiver has used `bytes` more of the stream's body: the sender may send that much more. */
  credit: z.object({ bytes: z.int().min(1).max(TUNNEL_WINDOW_BYTES) }),
  reset: z.object({ code: tunnelResetCodeSchema }),
  /** A phone's WebSocket upgrade. The PC answers `ws-accept` or `ws-reject`. */
  'ws-open': z.object({ path: pathSchema, headers: headersSchema, clientIp: clientIpSchema }),
  'ws-accept': z.object({}),
  /** The PC refused the upgrade: the relay answers the phone with this status. */
  'ws-reject': z.object({ status: z.int().min(400).max(599) }),
  'ws-msg': z.object({ text: z.boolean() }),
  'ws-close': z.object({ code: z.int().min(1000).max(4999), reason: z.string().max(123) }),
};

type Meta = typeof streamMeta;
export type TunnelFrameType = keyof Meta;

/** Frame types and their numbers on the wire. Never renumber one: add new ones. */
const TYPE_CODES: Record<TunnelFrameType, number> = {
  hello: 1,
  ready: 2,
  req: 3,
  res: 4,
  data: 5,
  end: 6,
  credit: 7,
  reset: 8,
  'ws-open': 9,
  'ws-accept': 10,
  'ws-reject': 11,
  'ws-msg': 12,
  'ws-close': 13,
};
const TYPE_OF_CODE = new Map(
  Object.entries(TYPE_CODES).map(([type, code]) => [code, type as TunnelFrameType]),
);

/** Frames on stream 0. Every other frame belongs to a stream (1 and up). */
const CONNECTION_FRAMES = new Set<TunnelFrameType>(['hello', 'ready']);
/** Frames that carry body bytes. */
const BODY_FRAMES = new Set<TunnelFrameType>(['data', 'ws-msg']);

/** Frames whose meta is empty (zod infers `{}` as a record of `never`, so leave it out). */
type EmptyMeta = 'data' | 'end' | 'ws-accept';

type FrameOf<T extends TunnelFrameType> = { type: T } & (T extends EmptyMeta
  ? unknown
  : z.infer<Meta[T]>) &
  (T extends 'hello' | 'ready' ? unknown : { stream: number }) &
  (T extends 'data' | 'ws-msg' ? { data: Uint8Array } : unknown);

export type TunnelFrame = { [T in TunnelFrameType]: FrameOf<T> }[TunnelFrameType];
/** One kind of frame, e.g. `TunnelFrameOf<'req'>`. */
export type TunnelFrameOf<T extends TunnelFrameType> = FrameOf<T>;

/** A frame that can't be read: the connection is closed with `TUNNEL_CLOSE_PROTOCOL`. */
export class TunnelProtocolError extends Error {
  override readonly name = 'TunnelProtocolError';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** The frame as one binary WebSocket message. */
export function encodeTunnelFrame(frame: TunnelFrame): Uint8Array {
  const { type, ...rest } = frame;
  const fields = rest as Record<string, unknown>;
  const stream = typeof fields.stream === 'number' ? fields.stream : 0;
  const data = fields.data instanceof Uint8Array ? fields.data : new Uint8Array(0);
  const meta = { ...fields };
  delete meta.stream;
  delete meta.data;
  const json = Object.keys(meta).length > 0 ? encoder.encode(JSON.stringify(meta)) : null;
  const metaLength = json?.length ?? 0;
  if (metaLength > TUNNEL_MAX_META_BYTES) throw new TunnelProtocolError(`${type}: meta too big`);
  if (data.length > TUNNEL_CHUNK_BYTES) throw new TunnelProtocolError(`${type}: body too big`);
  const bytes = new Uint8Array(9 + metaLength + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, TYPE_CODES[type]);
  view.setUint32(1, stream);
  view.setUint32(5, metaLength);
  if (json) bytes.set(json, 9);
  bytes.set(data, 9 + metaLength);
  return bytes;
}

/** Reads one binary message. Throws `TunnelProtocolError` for anything malformed. */
export function decodeTunnelFrame(bytes: Uint8Array): TunnelFrame {
  if (bytes.length < 9) throw new TunnelProtocolError('frame too short');
  if (bytes.length > TUNNEL_MAX_FRAME_BYTES) throw new TunnelProtocolError('frame too big');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = TYPE_OF_CODE.get(view.getUint8(0));
  if (!type) throw new TunnelProtocolError(`unknown frame type ${view.getUint8(0)}`);
  const stream = view.getUint32(1);
  const metaLength = view.getUint32(5);
  if (metaLength > TUNNEL_MAX_META_BYTES || 9 + metaLength > bytes.length) {
    throw new TunnelProtocolError(`${type}: bad meta length`);
  }
  if (CONNECTION_FRAMES.has(type) ? stream !== 0 : stream === 0) {
    throw new TunnelProtocolError(`${type}: wrong stream ${stream}`);
  }
  const data = bytes.subarray(9 + metaLength);
  if (!BODY_FRAMES.has(type) && data.length > 0) {
    throw new TunnelProtocolError(`${type}: unexpected body`);
  }
  let json: unknown = {};
  if (metaLength > 0) {
    try {
      json = JSON.parse(decoder.decode(bytes.subarray(9, 9 + metaLength)));
    } catch {
      throw new TunnelProtocolError(`${type}: meta isn't JSON`);
    }
  }
  const parsed = streamMeta[type].safeParse(json);
  if (!parsed.success) {
    throw new TunnelProtocolError(`${type}: ${parsed.error.issues[0]?.message ?? 'bad meta'}`);
  }
  const frame: Record<string, unknown> = { type, ...parsed.data };
  if (!CONNECTION_FRAMES.has(type)) frame.stream = stream;
  if (BODY_FRAMES.has(type)) frame.data = data;
  return frame as TunnelFrame;
}

/**
 * Hop-by-hop headers: they describe one connection, so neither end forwards them. The
 * WebSocket handshake headers are made fresh by whoever does the next upgrade.
 */
export const TUNNEL_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
]);

/** `https://pocketmoneypal.app` → `wss://pocketmoneypal.app/connect`. */
export function tunnelConnectUrl(relayUrl: string): string {
  const url = new URL(TUNNEL_CONNECT_PATH, relayUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.toString();
}

/**
 * The wait before reconnect number `attempt` (0 first): doubling from `baseMs` up to
 * `maxMs`, with "equal jitter" (between half and all of it), so thousands of PCs
 * reconnecting after a relay restart spread out without any of them waiting 0 ms.
 */
export function tunnelBackoffMs(
  attempt: number,
  random: () => number,
  { baseMs = 1_000, maxMs = 5 * 60_000 }: { baseMs?: number; maxMs?: number } = {},
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * The sending side of one stream's credit window. `take` what you send, and `grant` the
 * receiver's `credit` frames. `ready()` waits until something may be sent, and rejects
 * once `close()`d (the stream ended or the tunnel dropped).
 */
export class TunnelSendWindow {
  private waiting: { resolve: () => void; reject: (err: Error) => void }[] = [];
  private closed: Error | null = null;

  constructor(private open = TUNNEL_WINDOW_BYTES) {}

  /** Bytes that may be sent now. */
  get available(): number {
    return this.open;
  }

  take(bytes: number): void {
    if (bytes > this.open) throw new TunnelProtocolError('sent past the window');
    this.open -= bytes;
  }

  grant(bytes: number): void {
    this.open += bytes;
    if (this.open > 0) for (const w of this.waiting.splice(0)) w.resolve();
  }

  ready(): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    if (this.open > 0) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  close(reason = new Error('stream closed')): void {
    this.closed ??= reason;
    for (const w of this.waiting.splice(0)) w.reject(this.closed);
  }
}

/**
 * The receiving side of one stream's credit window. `receive` each `data` frame (it throws
 * if the sender went past the window), and `consume` the bytes as they're used: it says
 * how much `credit` to send back, batched to a quarter of the window.
 */
export class TunnelReceiveWindow {
  /** Received and not yet credited back. */
  private outstanding = 0;
  /** Consumed and not yet credited back. */
  private consumed = 0;

  constructor(private readonly size = TUNNEL_WINDOW_BYTES) {}

  receive(bytes: number): void {
    if (this.outstanding + bytes > this.size) {
      throw new TunnelProtocolError('received past the window');
    }
    this.outstanding += bytes;
  }

  /** Returns the credit to send now, or 0 to wait for more. */
  consume(bytes: number): number {
    this.consumed += bytes;
    if (this.consumed < this.size / 4 && this.consumed < this.outstanding) return 0;
    const credit = this.consumed;
    this.outstanding -= credit;
    this.consumed = 0;
    return credit;
  }
}
