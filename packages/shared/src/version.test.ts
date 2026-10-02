import { describe, expect, it } from 'vitest';
import { DEV_BUILD, serverVersionSchema, versionStatus } from './version';

describe('versionStatus', () => {
  const client = { build: 'b1', apiVersion: 3 };

  it('is current when the builds match', () => {
    expect(versionStatus(client, { build: 'b1', apiVersion: 3 })).toBe('current');
  });

  it('is stale when the server serves another build of the same API', () => {
    expect(versionStatus(client, { build: 'b2', apiVersion: 3 })).toBe('stale');
  });

  it('is incompatible when the API version differs, whatever the build', () => {
    expect(versionStatus(client, { build: 'b1', apiVersion: 4 })).toBe('incompatible');
    expect(versionStatus(client, { build: 'b2', apiVersion: 2 })).toBe('incompatible');
    expect(versionStatus(client, { build: null, apiVersion: 4 })).toBe('incompatible');
  });

  it('never calls a development client or a server with no build stale', () => {
    expect(versionStatus({ build: DEV_BUILD, apiVersion: 3 }, { build: 'b2', apiVersion: 3 })).toBe(
      'current',
    );
    expect(versionStatus(client, { build: null, apiVersion: 3 })).toBe('current');
  });
});

describe('serverVersionSchema', () => {
  it('reads the version out of a larger message and ignores the rest', () => {
    const hello = { type: 'hello', serverTime: 'x', clients: 2, build: 'b9', apiVersion: 1 };
    expect(serverVersionSchema.parse(hello)).toEqual({ build: 'b9', apiVersion: 1 });
  });

  it('rejects a message without a version (a server older than ADR 0011)', () => {
    expect(serverVersionSchema.safeParse({ type: 'hello', clients: 1 }).success).toBe(false);
  });
});
