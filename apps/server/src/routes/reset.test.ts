import { serverEventSchema, setupStatusSchema, type ServerEvent } from '@pmp/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/client';
import { familySettings, ledger, setupDrafts } from '../db/schema';
import { getKv } from '../repo/kv';
import { insertParent } from '../repo/users';
import { ensureDay } from '../scheduler';
import { addChild, addChore, pairedCookie, PHONE_IP, testDb } from '../test-helpers';

let db: Db;
let close: () => void;
let app: FastifyInstance;
let sent: ServerEvent[];
let cookie: string;
let scheduled: number;

beforeEach(async () => {
  ({ db, close } = testDb());
  scheduled = 0;
  app = await buildApp({
    db,
    webDist: null,
    now: () => Date.parse('2026-10-04T15:00:00Z'),
    onScheduleChanged: () => scheduled++,
  });
  sent = [];
  const broadcast = app.hub.broadcast.bind(app.hub);
  app.hub.broadcast = (event) => {
    sent.push(serverEventSchema.parse(event));
    broadcast(event);
  };
});
afterEach(async () => {
  await app.close();
  close();
});

/** A family that has played a bit: parents, a paired phone, quests, today's board, points. */
async function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  insertParent(db, { name: 'Dad' });
  const billy = addChild(db, 'Billy');
  addChore(db, [billy.id]);
  ensureDay(db, '2026-10-04', Date.parse('2026-10-04T00:00:00Z'));
  cookie = pairedCookie(db, mum.id);
  const adjusted = await asPhone({
    method: 'POST',
    url: `/api/children/${billy.id}/adjust`,
    payload: { points: 10 },
  });
  expect(adjusted.statusCode).toBe(201);
  db.update(familySettings).set({ familyName: 'The Smiths', centsPerPoint: 9 }).run();
}

const asPhone = (opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: PHONE_IP, headers: { cookie, ...opts.headers } });

const reset = (confirm: unknown = 'RESET') =>
  asPhone({ method: 'POST', url: '/api/factory-reset', payload: { confirm } });

const rowCount = (table: string) =>
  db.$client.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number;

const familyTables = () =>
  (
    db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
      )
      .pluck()
      .all() as string[]
  ).filter((t) => !['server_kv', 'family_settings', 'setup_drafts'].includes(t));

describe('POST /api/factory-reset', () => {
  it('needs a paired phone and the typed word', async () => {
    await seed();
    const unpaired = await app.inject({
      method: 'POST',
      url: '/api/factory-reset',
      remoteAddress: PHONE_IP,
      payload: { confirm: 'RESET' },
    });
    expect(unpaired.statusCode).toBe(401);
    expect((await reset('reset')).statusCode).toBe(400);
    expect(
      (await asPhone({ method: 'POST', url: '/api/factory-reset', payload: {} })).statusCode,
    ).toBe(400);
    expect(rowCount('users')).toBe(3);
  });

  it('empties every family table and starts setup again', async () => {
    await seed();
    const vapid = getKv(db, 'vapid');
    expect(rowCount('ledger')).toBeGreaterThan(0);

    const res = await reset();
    expect(res.statusCode).toBe(200);
    const { setupToken } = res.json<{ setupToken: string }>();

    for (const table of familyTables())
      expect({ table, rows: rowCount(table) }).toEqual({ table, rows: 0 });
    const settings = db.select().from(familySettings).all();
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ id: 1, familyName: 'Our Family', centsPerPoint: 5 });
    expect(db.select().from(setupDrafts).get()?.token).toBe(setupToken);
    // The server's own identity stays.
    expect(getKv(db, 'vapid')).toBe(vapid);

    const status = setupStatusSchema.parse(
      (await app.inject({ url: '/api/setup/status', remoteAddress: PHONE_IP })).json(),
    );
    expect(status.needed).toBe(true);
    expect(sent).toContainEqual({ type: 'data.changed' });
    expect(scheduled).toBe(1);
    expect(String(res.headers['set-cookie'])).toMatch(/pmp_device=;/);
  });

  it('unpairs every phone', async () => {
    await seed();
    await reset();
    const me = await asPhone({ url: '/api/children' });
    expect(me.statusCode).toBe(401);
  });

  it('keeps the ledger append-only afterwards', async () => {
    await seed();
    await reset();
    const kid = addChild(db, 'Alice');
    db.insert(ledger).values({ childId: kid.id, kind: 'bonus', points: 1, at: 0 }).run();
    expect(() => db.delete(ledger).run()).toThrow(/append-only/);
  });

  it('lets the phone that reset run setup with the new token', async () => {
    await seed();
    const { setupToken } = (await reset()).json<{ setupToken: string }>();
    const draft = await app.inject({
      url: '/api/setup/draft',
      remoteAddress: PHONE_IP,
      headers: { 'x-setup-token': setupToken },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toEqual({ draft: null });
  });
});
