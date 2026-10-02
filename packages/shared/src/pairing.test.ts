import { describe, expect, it } from 'vitest';
import { formatPairingCode, normalisePairingCode, PAIRING_ALPHABET } from './pairing';

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
