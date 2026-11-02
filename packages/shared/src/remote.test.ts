import { describe, expect, it } from 'vitest';
import {
  acceptsLicenceKeyEdit,
  formatLicenceKey,
  licenceKeyCaret,
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

describe('formatLicenceKey', () => {
  it('shows a pasted key as printed, whatever its spacing or case', () => {
    expect(formatLicenceKey('PMP-K7QM4-PXD2R-ABCDE-FGHJK')).toBe('PMP-K7QM4-PXD2R-ABCDE-FGHJK');
    expect(formatLicenceKey(' pmp k7qm4 pxd2r abcde fghjk ')).toBe('PMP-K7QM4-PXD2R-ABCDE-FGHJK');
    expect(formatLicenceKey('k7qm4pxd2rabcdefghjk')).toBe('PMP-K7QM4-PXD2R-ABCDE-FGHJK');
  });

  it('adds the prefix and dashes while typing', () => {
    expect(formatLicenceKey('k')).toBe('PMP-K');
    expect(formatLicenceKey('k7qm4')).toBe('PMP-K7QM4');
    expect(formatLicenceKey('k7qm4p')).toBe('PMP-K7QM4-P');
    expect(formatLicenceKey('PMP-K7QM4-')).toBe('PMP-K7QM4');
  });

  it('leaves the start of the prefix alone, so it can be typed or deleted', () => {
    expect(formatLicenceKey('')).toBe('');
    expect(formatLicenceKey('p')).toBe('P');
    expect(formatLicenceKey('pm')).toBe('PM');
    expect(formatLicenceKey('PMP')).toBe('PMP');
    expect(formatLicenceKey('PMP-')).toBe('PMP');
    expect(formatLicenceKey('pmpk')).toBe('PMP-K');
  });

  it('treats a key starting with P (no prefix) as the key', () => {
    expect(formatLicenceKey('px')).toBe('PMP-PX');
    expect(formatLicenceKey('pmx')).toBe('PMP-PMX');
  });

  it('stops at 20 characters', () => {
    expect(formatLicenceKey('PMP-K7QM4-PXD2R-ABCDE-FGHJK-EXTRA')).toBe(
      'PMP-K7QM4-PXD2R-ABCDE-FGHJK',
    );
  });

  it('reads back to the same key the relay hashes', () => {
    const typed = 'k7qm4 pxd2r abcde fghjk';
    expect(normaliseLicenceKey(formatLicenceKey(typed))).toBe(normaliseLicenceKey(typed));
  });
});

describe('acceptsLicenceKeyEdit', () => {
  const full = 'PMP-K7QM4-PXD2R-ABCDE-FGHJK';

  it('refuses one more character typed into a complete key', () => {
    expect(acceptsLicenceKeyEdit(full, 'PMP-K7XQM4-PXD2R-ABCDE-FGHJK')).toBe(false);
    expect(acceptsLicenceKeyEdit(full, `${full}X`)).toBe(false);
  });

  it('takes everything else: typing, deleting, and pasting over the key', () => {
    expect(acceptsLicenceKeyEdit('PMP-K7QM4', 'PMP-K7QM4P')).toBe(true);
    expect(acceptsLicenceKeyEdit(full, 'PMP-K7QM4-PXD2R-ABCDE-FGHJ')).toBe(true);
    expect(acceptsLicenceKeyEdit(full, ' pmp k7qm4 pxd2r abcde fghjk extra')).toBe(true);
  });
});

describe('licenceKeyCaret', () => {
  const caretFor = (raw: string, caret = raw.length) =>
    licenceKeyCaret(raw, caret, formatLicenceKey(raw));

  it('stays at the end while typing at the end', () => {
    expect(caretFor('k')).toBe('PMP-K'.length);
    expect(caretFor('PMP-K7QM4p')).toBe('PMP-K7QM4-P'.length);
  });

  it('stays put when typing or deleting in the middle', () => {
    // "X" typed after "K7" in "PMP-K7QM4-PXD2R": the cursor stays just after the X.
    expect(caretFor('PMP-K7XQM4-PXD2R', 'PMP-K7X'.length)).toBe('PMP-K7X'.length);
    // The "Q" deleted: just after the 7.
    expect(caretFor('PMP-K7M4-PXD2R', 'PMP-K7'.length)).toBe('PMP-K7'.length);
  });

  it('counts the added prefix', () => {
    expect(caretFor('k7q', 2)).toBe('PMP-K7'.length);
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
