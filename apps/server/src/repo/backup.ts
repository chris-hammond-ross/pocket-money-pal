/**
 * Backup and restore (ADR 0020). A backup is a copy of the database made with
 * `VACUUM INTO`, plus two tables of its own: `pmp_backup_meta` and the jar pictures in
 * `pmp_backup_images`. It carries its own migrations record, so an older backup is brought
 * up to date by the normal migrations before it's restored.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupSummary } from '@pmp/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from '../db/client';
import * as schema from '../db/schema';
import type { GoalImageFile } from '../goal-image';
import { findDeviceByToken, hashDeviceToken, pairDevice } from './devices';
import { recordEvent } from './events';
import { getSettings } from './settings';
import { rewriteFamilyData } from './reset';
import { findParent, listChildren, listParents } from './users';

/** Bumped if the backup's own tables change in a way an older server can't read. */
export const BACKUP_FORMAT = 1;

/** Why an upload was refused: `invalid` (400), `newer` or `old` (409). */
export type BackupProblem = 'invalid' | 'newer' | 'old';

export class BackupError extends Error {
  constructor(readonly problem: BackupProblem | 'no-parent') {
    super(`Backup refused: ${problem}`);
  }
}

/** A file in its own temp folder, removed with `cleanup`. */
export interface TempFile {
  file: string;
  cleanup: () => Promise<void>;
}

async function tempFile(name: string): Promise<TempFile> {
  const dir = await mkdtemp(join(tmpdir(), 'pmp-backup-'));
  return {
    file: join(dir, name),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Rows in a table that isn't part of the app: written into backups only. */
const META_TABLE = 'pmp_backup_meta';
const IMAGES_TABLE = 'pmp_backup_images';

/** Tables a backup doesn't carry over: the setup token and short-lived pairing codes. */
const NOT_RESTORED = new Set(['setup_drafts', 'pairing_codes']);

/** `server_kv` keys that belong to this server, not the family: never taken from a backup. */
const OWN_KV = ['secure_url'];

/** Makes a backup file of the whole family, with its jar pictures. */
export async function createBackup(
  db: Db,
  args: { images: GoalImageFile[]; appVersion: string; now: number },
): Promise<TempFile> {
  const out = await tempFile('backup.pmpbackup');
  try {
    // A consistent copy, even while the app is writing.
    db.$client.prepare('VACUUM INTO ?').run(out.file);
    const copy = new Database(out.file);
    try {
      copy.exec(`
        CREATE TABLE ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE ${IMAGES_TABLE} (name TEXT PRIMARY KEY, bytes BLOB NOT NULL);
        DELETE FROM setup_drafts;
        DELETE FROM pairing_codes;
      `);
      const meta = copy.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`);
      const image = copy.prepare(`INSERT INTO ${IMAGES_TABLE} (name, bytes) VALUES (?, ?)`);
      copy.transaction(() => {
        meta.run('format', String(BACKUP_FORMAT));
        meta.run('app_version', args.appVersion);
        meta.run('exported_at', String(args.now));
        for (const { name, bytes } of args.images) image.run(name, bytes);
      })();
    } finally {
      copy.close();
    }
    return out;
  } catch (err) {
    await out.cleanup();
    throw err;
  }
}

/** The newest migration a database has applied (its folder time), or 0. */
function lastMigration(sqlite: Database.Database): number {
  const row = sqlite.prepare('SELECT max(created_at) FROM __drizzle_migrations').pluck().get();
  return Number(row ?? 0);
}

function hasTable(sqlite: Database.Database, name: string, schemaName = 'main'): boolean {
  return (
    sqlite
      .prepare(`SELECT 1 FROM ${schemaName}.sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Checks an uploaded backup and brings it up to date: it must be a backup this server can
 * read, intact, from this version of the app or an older one. Returns the up-to-date copy
 * (removed with `cleanup`) and what's in it. `token` is the asking phone's device token.
 */
export async function inspectBackup(
  db: Db,
  upload: Buffer,
  args: { migrationsDir: string | null; token?: string },
): Promise<TempFile & { summary: BackupSummary }> {
  if (!upload.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw new BackupError('invalid');
  }
  const out = await tempFile('restore.db');
  try {
    await writeFile(out.file, upload);
    const summary = checkAndMigrate(db, out.file, args);
    return { ...out, summary };
  } catch (err) {
    await out.cleanup();
    if (err instanceof BackupError) throw err;
    throw new BackupError('invalid');
  }
}

function checkAndMigrate(
  db: Db,
  file: string,
  { migrationsDir, token }: { migrationsDir: string | null; token?: string },
): BackupSummary {
  const sqlite = new Database(file, { fileMustExist: true });
  try {
    if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new BackupError('invalid');
    }
    if (!hasTable(sqlite, META_TABLE) || !hasTable(sqlite, '__drizzle_migrations')) {
      throw new BackupError('invalid');
    }
    const meta = new Map(
      (sqlite.prepare(`SELECT key, value FROM ${META_TABLE}`).all() as Meta[]).map((r) => [
        r.key,
        r.value,
      ]),
    );
    if (Number(meta.get('format')) > BACKUP_FORMAT) throw new BackupError('newer');

    const theirs = lastMigration(sqlite);
    const ours = lastMigration(db.$client);
    if (theirs > ours) throw new BackupError('newer');
    if (theirs < ours) {
      if (!migrationsDir) throw new BackupError('old');
      migrate(drizzle(sqlite), { migrationsFolder: migrationsDir });
    }
    if ((sqlite.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new BackupError('invalid');
    }

    const copy = drizzle(sqlite, { schema });
    const knowsThisPhone = token
      ? sqlite
          .prepare('SELECT 1 FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
          .get(hashDeviceToken(token)) !== undefined
      : false;
    return {
      familyName: getSettings(copy).familyName,
      exportedAt: Number(meta.get('exported_at') ?? 0),
      appVersion: meta.get('app_version') ?? '',
      players: listChildren(copy).map((c) => ({ name: c.name, avatar: c.avatar })),
      parents: listParents(copy).map((p) => ({ id: p.id, name: p.name })),
      knowsThisPhone,
    };
  } finally {
    sqlite.close();
  }
}

interface Meta {
  key: string;
  value: string;
}

export interface RestoreResult {
  /** The backup's jar pictures, to be written once the restore has committed. */
  images: GoalImageFile[];
  /** This phone is paired after the restore: kept from the backup, or newly paired. */
  paired: boolean;
  /** The new device token when the phone was paired just now. */
  newToken: string | null;
}

/**
 * Replaces all of the family's data with a checked backup's (from `inspectBackup`), in one
 * transaction. This server keeps its own HTTPS address; everything else, the push keys
 * included, comes from the backup, so its paired phones work again at once. The phone
 * holding `token` stays paired if the backup knows it; otherwise `pairAs` pairs it.
 */
export function restoreBackup(
  db: Db,
  file: string,
  args: {
    now: number;
    token?: string;
    pairAs?: { parentId: number; deviceName: string };
  },
): RestoreResult {
  const sqlite = db.$client;
  // ATTACH can't run inside a transaction.
  sqlite.prepare('ATTACH DATABASE ? AS bak').run(file);
  try {
    const images = (
      sqlite.prepare(`SELECT name, bytes FROM bak.${IMAGES_TABLE}`).all() as GoalImageFile[]
    ).map(({ name, bytes }) => ({ name, bytes: Buffer.from(bytes) }));

    const pairing = rewriteFamilyData(sqlite, (tables) => {
      for (const table of tables) {
        if (NOT_RESTORED.has(table) || !hasTable(sqlite, table, 'bak')) continue;
        const theirs = new Set(columnsOf(sqlite, table, 'bak'));
        const cols = columnsOf(sqlite, table, 'main')
          .filter((c) => theirs.has(c))
          .map((c) => `"${c}"`)
          .join(', ');
        sqlite.exec(`INSERT INTO main."${table}" (${cols}) SELECT ${cols} FROM bak."${table}"`);
      }
      sqlite.prepare('INSERT OR IGNORE INTO main.family_settings (id) VALUES (1)').run();
      restoreKv(sqlite);
      // Row ids keep counting up past anything either database has used (ADR 0014).
      sqlite.exec(`
        UPDATE main.sqlite_sequence SET seq = max(seq, coalesce(
          (SELECT b.seq FROM bak.sqlite_sequence b WHERE b.name = sqlite_sequence.name), 0))
      `);
      return pairThisPhone(db, args);
    });
    return { images, ...pairing };
  } finally {
    sqlite.exec('DETACH DATABASE bak');
  }
}

function columnsOf(sqlite: Database.Database, table: string, schemaName: string): string[] {
  return sqlite
    .prepare('SELECT name FROM pragma_table_info(?, ?)')
    .pluck()
    .all(table, schemaName) as string[];
}

/** `server_kv`: the backup's family caches and push keys; this server's own address. */
function restoreKv(sqlite: Database.Database): void {
  const theirs = (
    sqlite.prepare('SELECT key, value, created_at, updated_at FROM bak.server_kv').all() as {
      key: string;
      value: string;
      created_at: string;
      updated_at: string;
    }[]
  ).filter((row) => !OWN_KV.includes(row.key));
  const keepVapid = !theirs.some((row) => row.key === 'vapid');
  const kept = keepVapid ? [...OWN_KV, 'vapid'] : OWN_KV;
  sqlite
    .prepare(`DELETE FROM main.server_kv WHERE key NOT IN (${kept.map(() => '?').join(', ')})`)
    .run(...kept);
  const insert = sqlite.prepare(
    'INSERT OR REPLACE INTO main.server_kv (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );
  for (const row of theirs) insert.run(row.key, row.value, row.created_at, row.updated_at);
}

function pairThisPhone(
  db: Db,
  { now, token, pairAs }: Parameters<typeof restoreBackup>[2],
): Omit<RestoreResult, 'images'> {
  const known = token ? findDeviceByToken(db, token) : null;
  let actorId = known?.parent.id ?? null;
  let newToken: string | null = null;
  if (!known && pairAs) {
    const parent = findParent(db, pairAs.parentId);
    if (!parent) throw new BackupError('no-parent');
    const paired = pairDevice(db, { userId: parent.id, name: pairAs.deviceName, now });
    recordEvent(db, {
      type: 'device.paired',
      at: now,
      actorId: parent.id,
      data: { deviceId: paired.device.id, name: paired.device.name, via: 'restore' },
    });
    actorId = parent.id;
    newToken = paired.token;
  }
  recordEvent(db, { type: 'backup.restored', at: now, actorId });
  return { paired: known !== null || newToken !== null, newToken };
}

/** A random id for a checked upload waiting to be restored. */
export function newUploadId(): string {
  return randomBytes(16).toString('base64url');
}
