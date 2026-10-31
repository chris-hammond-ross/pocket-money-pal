import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupInspectResultSchema,
  serverEventSchema,
  setupStatusSchema,
  type ServerEvent,
} from '@pmp/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { openDb, type Db } from '../db/client';
import * as schema from '../db/schema';
import { familySettings, goals, ledger, users } from '../db/schema';
import { createBackup } from '../repo/backup';
import { getKv, setKv } from '../repo/kv';
import { insertParent } from '../repo/users';
import { ensureDay } from '../scheduler';
import { addChild, addChore, migrationsDir, pairedCookie, PHONE_IP, testDb } from '../test-helpers';

let db: Db;
let close: () => void;
let app: FastifyInstance;
let sent: ServerEvent[];
let cookie: string;
let scheduled: number;
let imagesDir: string;
let mumId: number;

/** The smallest PNG: enough for `sniffImage`. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const IMAGE = 'goal-1-0123abcd.png';

beforeEach(async () => {
  ({ db, close } = testDb());
  imagesDir = mkdtempSync(join(tmpdir(), 'pmp-images-'));
  scheduled = 0;
  app = await buildApp({
    db,
    webDist: null,
    now: () => Date.parse('2026-10-04T15:00:00Z'),
    imagesDir,
    migrationsDir,
    imageFetcher: async () => null,
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
  rmSync(imagesDir, { recursive: true, force: true });
});

/** A family that has played a bit: parents, a paired phone, quests, points, a jar with a picture. */
async function seed() {
  const mum = insertParent(db, { name: 'Mum' });
  mumId = mum.id;
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
  db.insert(goals)
    .values({ childId: billy.id, name: 'Lego', emoji: '🧱', targetCents: 2000, imagePath: IMAGE })
    .run();
  writeFileSync(join(imagesDir, IMAGE), PNG);
  setKv(db, 'payday-notified', '123');
}

const asPhone = (opts: InjectOptions, withCookie = cookie) =>
  app.inject({
    ...opts,
    remoteAddress: PHONE_IP,
    headers: { ...(withCookie && { cookie: withCookie }), ...opts.headers },
  });

async function exportBackup(): Promise<Buffer> {
  const res = await asPhone({ url: '/api/backup' });
  expect(res.statusCode).toBe(200);
  return res.rawPayload;
}

const inspect = (file: Buffer, headers: Record<string, string> = {}, withCookie = cookie) =>
  asPhone(
    {
      method: 'POST',
      url: '/api/backup/inspect',
      payload: file,
      headers: { 'content-type': 'application/octet-stream', ...headers },
    },
    withCookie,
  );

const restore = (
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
  withCookie = cookie,
) => asPhone({ method: 'POST', url: '/api/backup/restore', payload, headers }, withCookie);

const factoryReset = async () => {
  const res = await asPhone({
    method: 'POST',
    url: '/api/factory-reset',
    payload: { confirm: 'RESET' },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ setupToken: string }>().setupToken;
};

/** Every row of the tables a restore brings back, to compare before and after. */
function snapshot(target: Db = db) {
  const tables = (
    target.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
      )
      .pluck()
      .all() as string[]
  ).filter((t) => !['events', 'setup_drafts', 'pairing_codes', 'server_kv'].includes(t));
  return Object.fromEntries(
    tables.map((t) => [t, target.$client.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]),
  );
}

describe('GET /api/backup', () => {
  it('needs a paired phone', async () => {
    await seed();
    expect((await asPhone({ url: '/api/backup' }, '')).statusCode).toBe(401);
  });

  it('downloads the family as one SQLite file', async () => {
    await seed();
    const res = await asPhone({ url: '/api/backup' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="pocket-money-pal-2026-10-04.pmpbackup"',
    );
    expect(res.rawPayload.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });
});

describe('export, factory reset, import', () => {
  it('brings everything back, during setup, and pairs the phone that restored', async () => {
    await seed();
    const before = snapshot();
    const vapid = getKv(db, 'vapid');
    const file = await exportBackup();
    const setupToken = await factoryReset();
    // The reset's own push keys are swapped back for the backup's.
    setKv(db, 'vapid', '{"publicKey":"other","privateKey":"other"}');
    expect(existsSync(join(imagesDir, IMAGE))).toBe(false);
    sent = [];
    scheduled = 0;

    const token = { 'x-setup-token': setupToken };
    const checked = await inspect(file, token, '');
    expect(checked.statusCode).toBe(200);
    const { uploadId, summary } = backupInspectResultSchema.parse(checked.json());
    expect(summary).toMatchObject({
      familyName: 'The Smiths',
      players: [{ name: 'Billy', avatar: '🦖' }],
      parents: [
        { id: mumId, name: 'Mum' },
        { id: expect.any(Number), name: 'Dad' },
      ],
      knowsThisPhone: false,
    });
    // Nothing has changed yet.
    expect(db.select().from(users).all()).toHaveLength(0);

    const res = await restore({ uploadId, parentId: mumId }, token, '');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ paired: true });
    const newCookie = String(res.headers['set-cookie']).split(';')[0]!;
    expect(newCookie).toMatch(/^pmp_device=.+/);

    const after = snapshot();
    // One more phone: the one that restored.
    expect(after.devices).toHaveLength(before.devices!.length + 1);
    expect({ ...after, devices: after.devices!.slice(0, -1) }).toEqual(before);
    expect(getKv(db, 'vapid')).toBe(vapid);
    expect(getKv(db, 'payday-notified')).toBe('123');
    expect(readFileSync(join(imagesDir, IMAGE))).toEqual(PNG);

    const status = setupStatusSchema.parse(
      (await app.inject({ url: '/api/setup/status', remoteAddress: PHONE_IP })).json(),
    );
    expect(status.needed).toBe(false);
    // The old phone is paired again, and so is the one that restored.
    expect((await asPhone({ url: '/api/children' })).statusCode).toBe(200);
    expect((await asPhone({ url: '/api/children' }, newCookie)).statusCode).toBe(200);
    expect(sent).toContainEqual({ type: 'data.changed' });
    expect(sent).toContainEqual({ type: 'setup.completed' });
    expect(scheduled).toBe(1);
  });

  it('keeps the ledger append-only and ids counting up', async () => {
    await seed();
    const file = await exportBackup();
    const setupToken = await factoryReset();
    const token = { 'x-setup-token': setupToken };
    const { uploadId } = backupInspectResultSchema.parse((await inspect(file, token, '')).json());
    expect((await restore({ uploadId, parentId: mumId }, token, '')).statusCode).toBe(200);

    expect(() => db.delete(ledger).run()).toThrow(/append-only/);
    const kid = addChild(db, 'Alice');
    const billy = db
      .select()
      .from(users)
      .all()
      .find((u) => u.name === 'Billy')!;
    expect(kid.id).toBeGreaterThan(billy.id);
  });

  it('refuses during setup without the PC or the setup token', async () => {
    await seed();
    const file = await exportBackup();
    await factoryReset();
    expect((await inspect(file, {}, '')).statusCode).toBe(403);
  });
});

describe('restoring over live data from a paired phone', () => {
  it('needs the typed word, then undoes everything since the backup', async () => {
    await seed();
    const file = await exportBackup();
    addChild(db, 'Alice');

    const checked = await inspect(file);
    expect(checked.statusCode).toBe(200);
    const { uploadId, summary } = backupInspectResultSchema.parse(checked.json());
    expect(summary.knowsThisPhone).toBe(true);

    expect((await restore({ uploadId })).statusCode).toBe(400);
    expect((await restore({ uploadId, confirm: 'nope' })).statusCode).toBe(400);
    expect(
      db
        .select()
        .from(users)
        .all()
        .map((u) => u.name),
    ).toContain('Alice');

    const res = await restore({ uploadId, confirm: 'restore' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ paired: true });
    expect(
      db
        .select()
        .from(users)
        .all()
        .map((u) => u.name),
    ).not.toContain('Alice');
    // Still paired, with the same cookie.
    expect((await asPhone({ url: '/api/children' })).statusCode).toBe(200);
  });

  it('needs a paired phone', async () => {
    await seed();
    const file = await exportBackup();
    expect((await inspect(file, {}, '')).statusCode).toBe(401);
    const { uploadId } = backupInspectResultSchema.parse((await inspect(file)).json());
    expect((await restore({ uploadId, confirm: 'RESTORE' }, {}, '')).statusCode).toBe(401);
  });

  it('forgets an upload once a newer one arrives, or once it is restored', async () => {
    await seed();
    const file = await exportBackup();
    const first = backupInspectResultSchema.parse((await inspect(file)).json());
    const second = backupInspectResultSchema.parse((await inspect(file)).json());
    expect((await restore({ uploadId: first.uploadId, confirm: 'RESTORE' })).statusCode).toBe(404);
    expect((await restore({ uploadId: second.uploadId, confirm: 'RESTORE' })).statusCode).toBe(200);
    expect((await restore({ uploadId: second.uploadId, confirm: 'RESTORE' })).statusCode).toBe(404);
  });
});

describe('checking an upload', () => {
  it('refuses anything that is not a backup, and leaves the family alone', async () => {
    await seed();
    const before = snapshot();
    expect((await inspect(Buffer.from('hello'))).json()).toEqual({ error: 'backup-invalid' });

    // A plain database copy, without the backup's own tables.
    const dir = mkdtempSync(join(tmpdir(), 'pmp-test-'));
    const plain = join(dir, 'plain.db');
    db.$client.prepare('VACUUM INTO ?').run(plain);
    const res = await inspect(readFileSync(plain));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'backup-invalid' });

    // A truncated backup.
    const file = await exportBackup();
    expect((await inspect(file.subarray(0, 4096))).statusCode).toBe(400);
    expect(snapshot()).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a backup made by a newer version', async () => {
    await seed();
    const backup = await createBackup(db, { images: [], appVersion: '9.9.9', now: 0 });
    const newer = openDb(backup.file, migrationsDir);
    newer.db.$client
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', ?)")
      .run(Date.parse('2099-01-01'));
    newer.close();
    const res = await inspect(readFileSync(backup.file));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'backup-newer' });
    await backup.cleanup();
  });

  it('brings a backup from an older version up to date', async () => {
    // A database built from every migration but the newest.
    const dir = mkdtempSync(join(tmpdir(), 'pmp-test-'));
    const oldMigrations = join(dir, 'drizzle');
    cpSync(migrationsDir, oldMigrations, { recursive: true });
    const journalPath = join(oldMigrations, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
    journal.entries.pop();
    writeFileSync(journalPath, JSON.stringify(journal));
    const sqlite = new Database(join(dir, 'old.db'));
    const old = drizzle(sqlite, { schema });
    migrate(old, { migrationsFolder: oldMigrations });
    sqlite.exec('INSERT INTO family_settings (id) VALUES (1)');
    insertParent(old, { name: 'Gran' });
    addChild(old, 'Cleo');
    const backup = await createBackup(old, { images: [], appVersion: '0.1.0', now: 0 });
    sqlite.close();

    await seed();
    const file = readFileSync(backup.file);
    const checked = await inspect(file);
    expect(checked.statusCode).toBe(200);
    const { uploadId, summary } = backupInspectResultSchema.parse(checked.json());
    expect(summary.players).toEqual([{ name: 'Cleo', avatar: '🦖' }]);
    expect(summary.knowsThisPhone).toBe(false);

    // This phone isn't in that backup: it pairs as the grown-up it picks.
    const res = await restore({ uploadId, confirm: 'RESTORE', parentId: summary.parents[0]!.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ paired: true });
    expect(
      db
        .select()
        .from(users)
        .all()
        .map((u) => u.name),
    ).toEqual(['Gran', 'Cleo']);
    await backup.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an older backup when the server has no migrations to hand', async () => {
    await app.close();
    app = await buildApp({ db, webDist: null, now: () => 0 });
    await seed();
    const dir = mkdtempSync(join(tmpdir(), 'pmp-test-'));
    const backup = await createBackup(db, { images: [], appVersion: '0.1.0', now: 0 });
    const older = openDb(backup.file, migrationsDir);
    older.db.$client
      .prepare(
        'DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)',
      )
      .run();
    older.close();
    const res = await inspect(readFileSync(backup.file));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'backup-old' });
    await backup.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
});
