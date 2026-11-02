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
