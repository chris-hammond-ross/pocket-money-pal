import { describe, expect, it } from 'vitest';
import {
  formatPairingCode,
  normalisePairingCode,
  PAIRING_ALPHABET,
  scannedPairingOf,
} from './pairing';

describe('pairing codes', () => {
  it('has no look-alike characters', () => {
    for (const ch of '01ILO') expect(PAIRING_ALPHABET).not.toContain(ch);
    expect(new Set(PAIRING_ALPHABET).size).toBe(31);
  });

  it('formats a code in two halves', () => {
    expect(formatPairingCode('K7QM4PXD')).toBe('K7QM-4PXD');
  });

  it('reads a typed code in any case, with or without the dash and spaces', () => {
    expect(normalisePairingCode('K7QM-4PXD')).toBe('K7QM4PXD');
    expect(normalisePairingCode(' k7qm 4pxd ')).toBe('K7QM4PXD');
  });

  it('refuses anything that cannot be a code', () => {
    expect(normalisePairingCode('K7QM-4PX')).toBeNull();
    expect(normalisePairingCode('K7QM-4PXDD')).toBeNull();
    expect(normalisePairingCode('K7QM-4PX0')).toBeNull();
    expect(normalisePairingCode('')).toBeNull();
  });
});

describe('scannedPairingOf', () => {
  it('reads a pairing link, on any address', () => {
    expect(scannedPairingOf('http://192.168.0.10:4789/parent/pair?code=K7QM4PXD')).toEqual({
      url: 'http://192.168.0.10:4789/parent/pair?code=K7QM4PXD',
      code: 'K7QM4PXD',
    });
    expect(
      scannedPairingOf(' https://k7qm.pocketmoneypal.app/parent/pair?code=k7qm-4pxd&moved=1 '),
    ).toMatchObject({ code: 'K7QM4PXD' });
  });

  it('reads a bare code', () => {
    expect(scannedPairingOf('K7QM-4PXD')).toEqual({ url: null, code: 'K7QM4PXD' });
  });

  it('reads the setup link from the kiosk title screen', () => {
    expect(scannedPairingOf('http://192.168.0.10:4789/setup?token=abc')).toEqual({
      url: 'http://192.168.0.10:4789/setup?token=abc',
      code: null,
    });
  });

  it('rejects anything else', () => {
    for (const text of [
      'https://example.com/',
      'http://192.168.0.10:4789/parent/pair?code=nope',
      'javascript:alert(1)',
      'WIFI:S:home;T:WPA;P:secret;;',
      '',
    ]) {
      expect(scannedPairingOf(text), text).toBeNull();
    }
  });
});
