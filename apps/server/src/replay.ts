import { encodeReplaced, OUTBOX_HEADERS, REPLAY_KEEP_MS, type ReplacedChange } from '@pmp/shared';
import { eq, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db/client';
import { replayedRequests } from './db/schema';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY = /^[A-Za-z0-9-]{8,64}$/;

/** The `Idempotency-Key` of a write, or null when it has none. */
function keyOf(req: FastifyRequest): string | null {
  const key = req.headers[OUTBOX_HEADERS.key];
  return WRITES.has(req.method) && typeof key === 'string' ? key : null;
}

/**
 * The PC's half of the phone's offline queue (spec 007, ADR 0017): a write with an
 * `Idempotency-Key` is applied once. Its answer (below 500, and not a 401) is kept for 30 days, and a
 * repeat of the key gets that answer without the route running again. A phone that lost
 * the answer and sends it again can't make a quest twice.
 */
export function installReplay(app: FastifyInstance, { db, now }: { db: Db; now: () => number }) {
  const replayed = new WeakSet<FastifyRequest>();

  app.addHook('onRequest', async (req, reply) => {
    const key = keyOf(req);
    if (key === null) return;
    if (!KEY.test(key)) return reply.code(400).send({ error: 'bad-idempotency-key' });
    const row = db.select().from(replayedRequests).where(eq(replayedRequests.key, key)).get();
    if (!row) return;
    replayed.add(req);
    if (row.replaced !== null) reply.header(OUTBOX_HEADERS.replaced, row.replaced);
    if (row.moved !== null) reply.header(OUTBOX_HEADERS.moved, row.moved);
    if (row.body !== null) reply.type('application/json; charset=utf-8');
    return reply.code(row.status).send(row.body ?? undefined);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const key = keyOf(req);
    if (key === null || replayed.has(req)) return payload;
    // A server error may be gone next time, and a phone that isn't paired may be re-paired.
    if (reply.statusCode >= 500 || reply.statusCode === 401) return payload;
    if (!KEY.test(key)) return payload;
    const header = (name: string) => {
      const value = reply.getHeader(name);
      return typeof value === 'string' ? value : null;
    };
    const at = now();
    db.transaction((tx) => {
      tx.delete(replayedRequests)
        .where(lt(replayedRequests.at, at - REPLAY_KEEP_MS))
        .run();
      tx.insert(replayedRequests)
        .values({
          key,
          status: reply.statusCode,
          body: typeof payload === 'string' && payload !== '' ? payload : null,
          replaced: header(OUTBOX_HEADERS.replaced),
          moved: header(OUTBOX_HEADERS.moved),
          at,
        })
        .onConflictDoNothing()
        .run();
    });
    return payload;
  });
}

/**
 * `X-PMP-Queued` on a change a phone queued while the PC was off: the PC's clock when the
 * phone last heard from it. Null for an ordinary request.
 */
export function queuedSince(req: FastifyRequest): number | null {
  const value = req.headers[OUTBOX_HEADERS.queued];
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/** Says on the answer that a queued change replaced another parent's newer one. */
export function sayReplaced(reply: FastifyReply, change: ReplacedChange | null): void {
  if (change) reply.header(OUTBOX_HEADERS.replaced, encodeReplaced(change));
}
