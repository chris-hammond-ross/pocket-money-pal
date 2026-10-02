import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_VERSION } from '@pmp/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_FILE, serverVersion } from './build-info';

describe('serverVersion', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('has no build without a web bundle', () => {
    expect(serverVersion(null)).toEqual({ build: null, apiVersion: API_VERSION });
  });

  it("reads the bundle's build id every time", () => {
    dir = mkdtempSync(join(tmpdir(), 'pmp-build-'));
    expect(serverVersion(dir).build).toBeNull();
    writeFileSync(join(dir, BUILD_FILE), JSON.stringify({ build: 'b1' }));
    expect(serverVersion(dir).build).toBe('b1');
    writeFileSync(join(dir, BUILD_FILE), JSON.stringify({ build: 'b2' }));
    expect(serverVersion(dir).build).toBe('b2');
  });

  it('treats a broken file as no build', () => {
    dir = mkdtempSync(join(tmpdir(), 'pmp-build-'));
    writeFileSync(join(dir, BUILD_FILE), '{nope');
    expect(serverVersion(dir).build).toBeNull();
  });
});
