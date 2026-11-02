/**
 * Hands-off remote access on the phone (spec 008, ADR 0025): what `GET /api/relay` says
 * about the PC's connection to the relay, and the licence key a parent types to connect.
 */
import { z } from 'zod';
import { tunnelProblemSchema } from './tunnel';

/**
 * A licence key as typed (" pmp-k7qm4-pxd2r … ") reduced to its characters, the way the
 * relay reads it (ADR 0024, the relay's `normaliseLicenceKey`): anything but letters and
 * digits goes, letters are read in any case, and the `PMP` prefix is optional.
 */
export function normaliseLicenceKey(input: string): string {
  const key = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return key.startsWith('PMP') && key.length === 23 ? key.slice(3) : key;
}

const LICENCE_PREFIX = 'PMP';
/** A key's own characters, after the prefix (ADR 0024). */
export const LICENCE_KEY_LENGTH = 20;
const LICENCE_GROUP = 5;

/**
 * What's typed or pasted, shown the way keys are printed: `PMP-XXXXX-XXXXX-XXXXX-XXXXX`.
 * Spaces, dashes and case don't matter, the prefix is added if it's missing, and anything
 * past 20 characters is dropped. A lone "P" or "PM" (the start of the prefix) and a bare
 * "PMP" stay as they are, so they can still be deleted.
 */
export function formatLicenceKey(input: string): string {
  const flat = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (flat === '' || LICENCE_PREFIX.startsWith(flat)) return flat;
  const body = (flat.startsWith(LICENCE_PREFIX) ? flat.slice(3) : flat).slice(
    0,
    LICENCE_KEY_LENGTH,
  );
  const groups = body.match(new RegExp(`.{1,${LICENCE_GROUP}}`, 'g')) ?? [];
  return [LICENCE_PREFIX, ...groups].join('-');
}

/**
 * False for one character typed into a key that's already complete: formatting would push
 * the last character off the end, and deleting the stray one wouldn't bring it back. A
 * paste over the key (any other change) is always taken.
 */
export function acceptsLicenceKeyEdit(previous: string, raw: string): boolean {
  const flat = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').length;
  const complete = LICENCE_PREFIX.length + LICENCE_KEY_LENGTH;
  return !(flat(previous) === complete && flat(raw) === complete + 1);
}

/**
 * Where the cursor goes after `formatLicenceKey` turned `raw` into `formatted`: after the
 * same characters it was after (dashes don't count), so typing or deleting in the middle
 * doesn't throw it to the end.
 */
export function licenceKeyCaret(raw: string, caret: number, formatted: string): number {
  const significant = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let before = significant(raw.slice(0, caret)).length;
  // The prefix was added for them: count it as typed.
  const flat = significant(raw);
  if (formatted.startsWith(`${LICENCE_PREFIX}-`) && !flat.startsWith(LICENCE_PREFIX)) {
    before += LICENCE_PREFIX.length;
  }
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (seen >= before) return i;
    if (/[A-Z0-9]/.test(formatted[i]!)) seen++;
  }
  return formatted.length;
}

/** The key's last four characters, shown in the Connected state. The PC never keeps the key. */
export function licenceHintOf(input: string): string {
  return normaliseLicenceKey(input).slice(-4);
}

/** `POST /api/relay`: connect with a licence key; `takeOver` moves it from another PC. */
export const relayConnectRequestSchema = z.object({
  licenceKey: z
    .string()
    .max(100)
    .refine((v) => normaliseLicenceKey(v).length > 0, 'Type the licence key'),
  takeOver: z.boolean().optional(),
});
export type RelayConnectRequest = z.infer<typeof relayConnectRequestSchema>;

export const relayStateSchema = z.enum(['off', 'connecting', 'connected', 'problem']);
export type RelayState = z.infer<typeof relayStateSchema>;

/** `GET /api/relay`, and the `relay.changed` event. Never the secret or the kiosk id. */
export const relayInfoSchema = z.object({
  state: relayStateSchema,
  /** The family's address while registered, e.g. `https://k7qm4pxd2r.pocketmoneypal.app`. */
  url: z.string().nullable(),
  /** Why the relay won't have this PC, while `problem`. */
  problem: tunnelProblemSchema.nullable(),
  /** When `state` last changed (epoch ms). "Reconnecting…" shows after 30 s of `connecting`. */
  since: z.number(),
  /** The last thing that went wrong, while trying again. */
  lastError: z.string().nullable(),
  /** The licence key's last four characters. */
  licenceHint: z.string().nullable(),
  /** The plain home-network address, for when the internet is down at home. */
  lanUrl: z.string().nullable(),
});
export type RelayInfo = z.infer<typeof relayInfoSchema>;

/** After this long trying to connect, the phone says "Reconnecting…" with the last error. */
export const RELAY_RECONNECTING_AFTER_MS = 30_000;

/**
 * `POST /api/relay`'s refusals. The relay's own codes pass through; `relay-unreachable`
 * (424) is the relay not answering, or answering something unexpected.
 */
export type RelayConnectProblem =
  | 'unknown-licence'
  | 'licence-expired'
  | 'licence-revoked'
  | 'licence-in-use'
  | 'update-needed'
  | 'rate-limited'
  | 'relay-unreachable';
