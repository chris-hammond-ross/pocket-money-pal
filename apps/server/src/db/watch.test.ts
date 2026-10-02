import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrationsDir } from '../test-helpers';
import { openDb, type Db } from './client';
import { familySettings } from './schema';
import { watchExternalWrites } from './watch';

let dir: string;
let server: { db: Db; close: () => void };
let editor: { db: Db; close: () => void };

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'pmp-watch-'));
  const file = join(dir, 'pmp.db');
  server = openDb(file, migrationsDir);
  editor = openDb(file, migrationsDir); // e.g. a SQLite editor on the same file
});
afterEach(() => {
  vi.useRealTimers();
  server.close();
  editor.close();
  rmSync(dir, { recursive: true, force: true });
});

const rename = (db: Db, familyName: string) =>
  db.update(familySettings).set({ familyName }).where(eq(familySettings.id, 1)).run();

describe('watchExternalWrites', () => {
  it("fires for another connection's writes, once per check", () => {
    const onChange = vi.fn();
    const stop = watchExternalWrites(server.db, onChange, 1000);

    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();

    rename(editor.db, 'The Smiths');
    rename(editor.db, 'The Joneses');
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    rename(editor.db, 'Again');
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores the server's own writes (they broadcast their own events)", () => {
    const onChange = vi.fn();
    const stop = watchExternalWrites(server.db, onChange, 1000);
    rename(server.db, 'Ours');
    vi.advanceTimersByTime(2000);
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });
});
