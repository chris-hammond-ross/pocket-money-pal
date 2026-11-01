import { describe, expect, it } from 'vitest';
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  tunnelBackoffMs,
  tunnelConnectUrl,
  tunnelProblemOfClose,
  tunnelProblemOfStatus,
  TunnelProtocolError,
  TunnelReceiveWindow,
  TunnelSendWindow,
  TUNNEL_CHUNK_BYTES,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PROBLEM_CLOSE,
  TUNNEL_PROBLEM_STATUS,
  TUNNEL_WINDOW_BYTES,
  type TunnelFrame,
  type TunnelFrameOf,
} from './tunnel';

const roundTrip = (frame: TunnelFrame) => decodeTunnelFrame(encodeTunnelFrame(frame));

/** A frame's bytes with the header rewritten. */
function withHeader(frame: TunnelFrame, edit: (view: DataView) => void): Uint8Array {
  const bytes = encodeTunnelFrame(frame);
  edit(new DataView(bytes.buffer));
  return bytes;
}

describe('tunnel frames', () => {
  const frames: TunnelFrame[] = [
    { type: 'hello', version: 1, appVersion: '0.2.5' },
    { type: 'ready', version: 1 },
    {
      type: 'req',
      stream: 1,
      method: 'POST',
      path: '/api/claims?x=1',
      headers: [
        ['cookie', 'a=1'],
        ['cookie', 'b=2'],
      ],
      clientIp: '203.0.113.9',
      end: false,
    },
    {
      type: 'res',
      stream: 1,
      status: 200,
      headers: [
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
      end: true,
    },
    { type: 'data', stream: 7, data: new Uint8Array([1, 2, 3]) },
    { type: 'end', stream: 7 },
    { type: 'credit', stream: 7, bytes: 65_536 },
    { type: 'reset', stream: 7, code: 'cancelled' },
    { type: 'ws-open', stream: 2, path: '/ws', headers: [], clientIp: '2001:db8::1' },
    { type: 'ws-accept', stream: 2 },
    { type: 'ws-reject', stream: 2, status: 401 },
    { type: 'ws-msg', stream: 2, text: true, data: new TextEncoder().encode('{"type":"x"}') },
    { type: 'ws-close', stream: 2, code: 1000, reason: 'bye' },
  ];

  it.each(frames.map((f) => [f.type, f] as const))('round-trips %s', (_type, frame) => {
    expect(roundTrip(frame)).toEqual(frame);
  });

  it('keeps repeated headers in order', () => {
    const frame = roundTrip(frames[3]!);
    expect(frame.type === 'res' && frame.headers.map(([, v]) => v)).toEqual(['a=1', 'b=2']);
  });

  it('carries a full chunk of binary body, and the stream id up to 2³²−1', () => {
    const data = new Uint8Array(TUNNEL_CHUNK_BYTES).map((_, i) => i % 251);
    const frame = roundTrip({ type: 'data', stream: 0xffffffff, data });
    expect(frame).toEqual({ type: 'data', stream: 0xffffffff, data });
  });

  it('reads a frame from inside a bigger buffer (a pooled Buffer, say)', () => {
    const bytes = encodeTunnelFrame({ type: 'credit', stream: 3, bytes: 10 });
    const pool = new Uint8Array(bytes.length + 20);
    pool.set(bytes, 13);
    expect(decodeTunnelFrame(pool.subarray(13, 13 + bytes.length))).toEqual({
      type: 'credit',
      stream: 3,
      bytes: 10,
    });
  });

  it('frames stay under a Worker message limit', () => {
    expect(TUNNEL_MAX_FRAME_BYTES).toBeLessThan(1024 * 1024);
  });

  it('refuses to encode a body bigger than a chunk', () => {
    const data = new Uint8Array(TUNNEL_CHUNK_BYTES + 1);
    expect(() => encodeTunnelFrame({ type: 'data', stream: 1, data })).toThrow(TunnelProtocolError);
  });

  describe('refuses malformed frames', () => {
    const bad: [string, Uint8Array][] = [
      ['too short', new Uint8Array(8)],
      ['unknown type', withHeader({ type: 'end', stream: 1 }, (v) => v.setUint8(0, 99))],
      ['meta past the end', withHeader({ type: 'ready', version: 1 }, (v) => v.setUint32(5, 1000))],
      [
        'stream frame on stream 0',
        withHeader({ type: 'end', stream: 1 }, (v) => v.setUint32(1, 0)),
      ],
      [
        'connection frame on a stream',
        withHeader({ type: 'ready', version: 1 }, (v) => v.setUint32(1, 5)),
      ],
      [
        'body on a frame without one',
        (() => {
          const b = encodeTunnelFrame({ type: 'end', stream: 1 });
          const out = new Uint8Array(b.length + 1);
          out.set(b);
          return out;
        })(),
      ],
      [
        'meta that fails its schema',
        (() => {
          const json = new TextEncoder().encode('{"bytes":-1}');
          const out = new Uint8Array(9 + json.length);
          const v = new DataView(out.buffer);
          v.setUint8(0, 7);
          v.setUint32(1, 1);
          v.setUint32(5, json.length);
          out.set(json, 9);
          return out;
        })(),
      ],
      [
        'meta that is not JSON',
        (() => {
          const out = new Uint8Array(9 + 3);
          const v = new DataView(out.buffer);
          v.setUint8(0, 2);
          v.setUint32(5, 3);
          out.set([0x7b, 0xff, 0x7d], 9);
          return out;
        })(),
      ],
      ['too big', new Uint8Array(TUNNEL_MAX_FRAME_BYTES + 1)],
    ];
    it.each(bad)('%s', (_name, bytes) => {
      expect(() => decodeTunnelFrame(bytes)).toThrow(TunnelProtocolError);
    });

    it('a request with a path that is not a path, or a client that is not an IP', () => {
      const req: TunnelFrameOf<'req'> = {
        type: 'req',
        stream: 1,
        method: 'GET',
        path: '/',
        headers: [],
        clientIp: '1.2.3.4',
        end: true,
      };
      for (const change of [
        { path: 'https://elsewhere/' },
        { path: '/a b' },
        { clientIp: 'not-an-ip' },
        { method: 'get' },
      ]) {
        expect(() => roundTrip({ ...req, ...change })).toThrow(TunnelProtocolError);
      }
    });
  });
});

describe('problems', () => {
  it('maps every refusal status and close code both ways', () => {
    for (const [problem, status] of Object.entries(TUNNEL_PROBLEM_STATUS)) {
      expect(tunnelProblemOfStatus(status)).toBe(problem);
    }
    for (const [problem, code] of Object.entries(TUNNEL_PROBLEM_CLOSE)) {
      expect(tunnelProblemOfClose(code)).toBe(problem);
    }
  });

  it('anything else is worth retrying', () => {
    expect(tunnelProblemOfStatus(503)).toBeNull();
    expect(tunnelProblemOfStatus(500)).toBeNull();
    expect(tunnelProblemOfClose(1001)).toBeNull();
    expect(tunnelProblemOfClose(1006)).toBeNull();
    expect(tunnelProblemOfClose(4000)).toBeNull();
  });
});

describe('tunnelConnectUrl', () => {
  it('turns the relay URL into its WebSocket /connect', () => {
    expect(tunnelConnectUrl('https://pocketmoneypal.app')).toBe('wss://pocketmoneypal.app/connect');
    expect(tunnelConnectUrl('https://staging.pocketmoneypal.app/')).toBe(
      'wss://staging.pocketmoneypal.app/connect',
    );
    expect(tunnelConnectUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/connect');
  });
});

describe('tunnelBackoffMs', () => {
  it('doubles, between half and all of the ceiling', () => {
    expect([0, 1, 2, 3].map((n) => tunnelBackoffMs(n, () => 0))).toEqual([500, 1000, 2000, 4000]);
    expect([0, 1, 2, 3].map((n) => tunnelBackoffMs(n, () => 1))).toEqual([1000, 2000, 4000, 8000]);
  });

  it('stops at the cap, even after a very long outage', () => {
    expect(tunnelBackoffMs(9, () => 1)).toBe(300_000);
    expect(tunnelBackoffMs(10_000, () => 1)).toBe(300_000);
    expect(tunnelBackoffMs(3, () => 1, { baseMs: 50, maxMs: 300 })).toBe(300);
  });
});

describe('credit windows', () => {
  it('a sender waits once the window is used, until credit comes', async () => {
    const w = new TunnelSendWindow(100);
    w.take(100);
    expect(w.available).toBe(0);
    let done = false;
    const waiting = w.ready().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    w.grant(40);
    await waiting;
    expect(w.available).toBe(40);
    expect(() => w.take(41)).toThrow(TunnelProtocolError);
  });

  it('closing rejects anyone waiting, and every later wait', async () => {
    const w = new TunnelSendWindow(0);
    const waiting = w.ready();
    w.close(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    await expect(w.ready()).rejects.toThrow('gone');
  });

  it('a receiver refuses data past the window', () => {
    const r = new TunnelReceiveWindow(100);
    r.receive(60);
    r.receive(40);
    expect(() => r.receive(1)).toThrow(TunnelProtocolError);
  });

  it('credit is batched to a quarter window, or sent when everything is used', () => {
    const r = new TunnelReceiveWindow(TUNNEL_WINDOW_BYTES);
    const chunk = TUNNEL_CHUNK_BYTES;
    for (let i = 0; i < 8; i++) r.receive(chunk);
    expect(r.consume(chunk)).toBe(0);
    expect(r.consume(chunk)).toBe(0);
    expect(r.consume(chunk)).toBe(0);
    expect(r.consume(chunk)).toBe(4 * chunk); // a quarter of 1 MiB
    expect(r.consume(chunk)).toBe(0);
    expect(r.consume(3 * chunk)).toBe(4 * chunk); // all of it
    // The window is open again: a full window may arrive.
    for (let i = 0; i < 16; i++) r.receive(chunk);
  });

  it('a small body is credited at once', () => {
    const r = new TunnelReceiveWindow();
    r.receive(10);
    expect(r.consume(10)).toBe(10);
  });
});
