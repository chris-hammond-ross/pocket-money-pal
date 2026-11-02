import { describe, expect, it } from 'vitest';
import {
  licenceHintOf,
  normaliseLicenceKey,
  relayConnectRequestSchema,
  relayInfoSchema,
} from './remote';
import { serverEventSchema } from './events';

describe('normaliseLicenceKey', () => {
  it('drops spaces, dashes and case, as the relay does', () => {
    expect(normaliseLicenceKey(' pmp-k7qm4-pxd2r-abcde-fghjk ')).toBe('K7QM4PXD2RABCDEFGHJK');
    expect(normaliseLicenceKey('K7QM4 PXD2R ABCDE FGHJK')).toBe('K7QM4PXD2RABCDEFGHJK');
  });

  it('keeps a key that happens to start with PMP when there is no prefix', () => {
    // 20 characters: the PMP is part of the key itself.
    expect(normaliseLicenceKey('PMPQ4PXD2RABCDEFGHJK')).toBe('PMPQ4PXD2RABCDEFGHJK');
  });
});

describe('licenceHintOf', () => {
  it('is the last four characters', () => {
    expect(licenceHintOf('PMP-K7QM4-PXD2R-ABCDE-fghjk')).toBe('GHJK');
  });
});

describe('relayConnectRequestSchema', () => {
  it('takes a key and an optional takeOver', () => {
    expect(relayConnectRequestSchema.parse({ licenceKey: 'abc', takeOver: true })).toEqual({
      licenceKey: 'abc',
      takeOver: true,
    });
  });

  it('refuses an empty or blank key, or one far too long', () => {
    expect(relayConnectRequestSchema.safeParse({ licenceKey: ' - ' }).success).toBe(false);
    expect(relayConnectRequestSchema.safeParse({ licenceKey: 'x'.repeat(101) }).success).toBe(
      false,
    );
    expect(relayConnectRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('relay.changed', () => {
  it('carries the public state', () => {
    const relay = relayInfoSchema.parse({
      state: 'problem',
      url: 'https://k7qm4pxd2r.pocketmoneypal.app',
      problem: 'moved',
      since: 1,
      lastError: null,
      licenceHint: 'GHJK',
      lanUrl: 'http://192.168.1.20:4789',
    });
    expect(serverEventSchema.parse({ type: 'relay.changed', relay })).toEqual({
      type: 'relay.changed',
      relay,
    });
  });
});
