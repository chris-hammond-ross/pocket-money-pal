/**
 * Phone pairing codes (ADR 0008): 8 characters from an alphabet without look-alikes
 * (no 0/O, 1/I/L), shown as "K7QM-4PXD" and typed back in any case, with or without the
 * dash. The server generates them; these pure functions format and read them.
 */

/** 31 symbols, so a code holds about 40 bits. */
export const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

/** "K7QM4PXD" → "K7QM-4PXD", for reading aloud or typing. */
export function formatPairingCode(code: string): string {
  const half = PAIRING_CODE_LENGTH / 2;
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/**
 * What a person typed (" k7qm-4pxd ") as a code ("K7QM4PXD"), or null when it can't be
 * one. Spaces and dashes are ignored, and letters are read in any case.
 */
export function normalisePairingCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  return [...code].every((ch) => PAIRING_ALPHABET.includes(ch)) ? code : null;
}
