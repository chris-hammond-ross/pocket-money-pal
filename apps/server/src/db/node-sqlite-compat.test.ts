import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from './node-sqlite-compat';

// The whole server suite also runs on this shim (vitest.node-sqlite.config.ts). These tests
// pin the parts of better-sqlite3's behaviour that the suite only touches indirectly.

let db: Database;
afterEach(() => db?.close());

function people(): Database {
  db = new Database();
  db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY, name TEXT, pic BLOB)');
  return db;
}

describe('node-sqlite-compat', () => {
  it('runs, gets and lists rows, binding undefined as NULL', () => {
    people();
    const r = db.prepare('INSERT INTO p (name, pic) VALUES (?, ?)').run('Billy', undefined);
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(db.prepare('SELECT id, name, pic FROM p').get()).toEqual({
      id: 1,
      name: 'Billy',
      pic: null,
    });
    expect(db.prepare('SELECT name FROM p').all()).toEqual([{ name: 'Billy' }]);
  });

  it('returns arrays from raw() and the first column from pluck()', () => {
    people();
    db.prepare('INSERT INTO p (name) VALUES (?), (?)').run('Billy', 'Alice');
    expect(db.prepare('SELECT id, name FROM p ORDER BY id').raw().all()).toEqual([
      [1, 'Billy'],
      [2, 'Alice'],
    ]);
    expect(db.prepare('SELECT count(*) FROM p').pluck().get()).toBe(2);
    expect([...db.prepare('SELECT name FROM p ORDER BY id').pluck().iterate()]).toEqual([
      'Billy',
      'Alice',
    ]);
  });

  it('gives blobs back as Buffers', () => {
    people();
    db.prepare('INSERT INTO p (name, pic) VALUES (?, ?)').run('Billy', Buffer.from([1, 2, 3]));
    const pic = db.prepare('SELECT pic FROM p').pluck().get();
    expect(Buffer.isBuffer(pic)).toBe(true);
    expect([...(pic as Buffer)]).toEqual([1, 2, 3]);
  });

  it('reads pragmas, simple or as rows', () => {
    people();
    expect(db.pragma('foreign_keys = ON')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('table_info(p)')).toHaveLength(3);
  });

  it('commits a transaction, and rolls back a nested one alone with a savepoint', () => {
    people();
    const insert = db.prepare('INSERT INTO p (name) VALUES (?)');
    const outer = db.transaction(() => {
      insert.run('Billy');
      expect(db.inTransaction).toBe(true);
      expect(() =>
        db.transaction(() => {
          insert.run('Alice');
          throw new Error('no');
        })(),
      ).toThrow('no');
      return 'done';
    });
    expect(outer.immediate()).toBe('done');
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT name FROM p').pluck().all()).toEqual(['Billy']);
  });

  it('rolls back the whole transaction when it throws', () => {
    people();
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO p (name) VALUES (?)').run('Billy');
        throw new Error('no');
      })(),
    ).toThrow('no');
    expect(db.prepare('SELECT count(*) FROM p').pluck().get()).toBe(0);
  });

  it('refuses a missing file with fileMustExist, and opens read-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmp-compat-'));
    try {
      const file = join(dir, 'a.db');
      expect(() => new Database(file, { fileMustExist: true })).toThrow(
        expect.objectContaining({ code: 'SQLITE_CANTOPEN' }),
      );
      new Database(file).exec('CREATE TABLE t (x)').close();
      db = new Database(file, { readonly: true, fileMustExist: true });
      expect(() => db.exec('INSERT INTO t VALUES (1)')).toThrow();
      expect(db.open).toBe(true);
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
