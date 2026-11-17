/**
 * The part of better-sqlite3 that Drizzle and the server use, over Node's built-in
 * `node:sqlite` (ADR 0029). The Android build bundles the server with `better-sqlite3`
 * aliased to this file, so no native module has to be built for Android: the Node there
 * has SQLite built in. The PC build doesn't use it; CI runs the whole server suite on it
 * (`vitest.node-sqlite.config.ts`), so the two drivers stay interchangeable.
 *
 * Covered: `prepare` → `run` / `all` / `get` / `iterate` / `raw` / `pluck`, `exec`,
 * `pragma` (with `simple`), `transaction` (with `deferred` / `immediate` / `exclusive`, and
 * savepoints when nested), `function`, `close`, and the `readonly` / `fileMustExist` options.
 * Blobs come back as `Buffer`, as better-sqlite3 returns them.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

type Row = Record<string, unknown> | unknown[];

function toBuffer(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;
}

function fixRow<T>(row: T): T {
  if (row == null) return row;
  if (Array.isArray(row)) return row.map(toBuffer) as T;
  const record = row as Record<string, unknown>;
  for (const key in record) record[key] = toBuffer(record[key]);
  return row;
}

/** better-sqlite3 binds `undefined` as NULL; `node:sqlite` refuses it. */
function fixParams(params: unknown[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : p)) as SQLInputValue[];
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class Statement {
  constructor(
    private readonly stmt: StatementSync,
    private readonly asArrays = false,
    private readonly plucked = false,
  ) {}

  raw(on = true): Statement {
    return new Statement(this.stmt, on, false);
  }

  pluck(on = true): Statement {
    return new Statement(this.stmt, false, on);
  }

  run(...params: unknown[]): RunResult {
    const r = this.ready().run(...fixParams(params));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  all(...params: unknown[]): unknown[] {
    return this.ready()
      .all(...fixParams(params))
      .map((row) => this.out(row as Row));
  }

  get(...params: unknown[]): unknown {
    return this.out(this.ready().get(...fixParams(params)) as Row | undefined);
  }

  *iterate(...params: unknown[]): IterableIterator<unknown> {
    for (const row of this.ready().iterate(...fixParams(params))) yield this.out(row as Row);
  }

  /** One `StatementSync` serves every mode; set the row shape before each use. */
  private ready(): StatementSync {
    this.stmt.setReturnArrays(this.asArrays || this.plucked);
    return this.stmt;
  }

  private out(row: Row | undefined): unknown {
    const fixed = fixRow(row);
    return this.plucked && Array.isArray(fixed) ? fixed[0] : fixed;
  }
}

export interface Options {
  readonly?: boolean;
  fileMustExist?: boolean;
}

type Transaction<F extends (...args: never[]) => unknown> = F & {
  deferred: F;
  immediate: F;
  exclusive: F;
};

export default class Database {
  readonly name: string;
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(file = ':memory:', options: Options = {}) {
    if (options.fileMustExist && file !== ':memory:' && !existsSync(file)) {
      throw Object.assign(new Error(`unable to open database file: ${file}`), {
        code: 'SQLITE_CANTOPEN',
      });
    }
    this.db = new DatabaseSync(file, { readOnly: options.readonly === true });
    this.name = file;
  }

  get open(): boolean {
    return this.db.isOpen;
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  /** Closing twice is harmless, as in better-sqlite3. */
  close(): this {
    if (this.db.isOpen) this.db.close();
    return this;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.db
      .prepare(`PRAGMA ${source}`)
      .all()
      .map((row) => fixRow(row));
    if (!options.simple) return rows;
    const first = rows[0];
    return first ? Object.values(first)[0] : undefined;
  }

  function(
    name: string,
    optionsOrFn: Record<string, unknown> | ((...args: never[]) => unknown),
    fn?: (...args: never[]) => unknown,
  ): this {
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
    const body = (typeof optionsOrFn === 'function' ? optionsOrFn : fn) as Parameters<
      DatabaseSync['function']
    >[1];
    this.db.function(name, options, body);
    return this;
  }

  /** better-sqlite3's transaction: the outermost call is BEGIN…COMMIT, inner ones savepoints. */
  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F> {
    const wrap = (begin: string): F =>
      ((...args: Parameters<F>) => {
        const outer = this.depth === 0;
        const savepoint = `pmp_sp_${this.depth}`;
        this.db.exec(outer ? begin : `SAVEPOINT ${savepoint}`);
        this.depth++;
        try {
          const result = fn(...args);
          this.depth--;
          this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
          return result;
        } catch (err) {
          this.depth--;
          try {
            this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          } catch {
            // SQLite already rolled back (e.g. after SQLITE_FULL); the original error matters.
          }
          throw err;
        }
      }) as F;
    return Object.assign(wrap('BEGIN'), {
      deferred: wrap('BEGIN DEFERRED'),
      immediate: wrap('BEGIN IMMEDIATE'),
      exclusive: wrap('BEGIN EXCLUSIVE'),
    });
  }
}
