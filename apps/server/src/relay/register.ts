/**
 * The relay's apex routes the PC calls over plain HTTPS (ADR 0024): `/register` with a
 * licence key, and `/unregister` with the PC's own upgrade headers when a parent turns
 * remote access off, so the licence is free again with the same address.
 */
import {
  tunnelRegistrationSchema,
  TUNNEL_KIOSK_HEADER,
  TUNNEL_PROTOCOL_VERSION,
  TUNNEL_VERSION_HEADER,
  type RelayConnectProblem,
  type RelayRecord,
  type TunnelRegistration,
} from '@pmp/shared';

/** How long the relay gets to answer. */
const RELAY_TIMEOUT_MS = 15_000;

/** The relay's refusals that `POST /api/relay` passes on, with the status it answers. */
const REGISTER_PROBLEMS: Record<string, { problem: RelayConnectProblem; status: number }> = {
  'unknown-licence': { problem: 'unknown-licence', status: 400 },
  'licence-expired': { problem: 'licence-expired', status: 402 },
  'licence-revoked': { problem: 'licence-revoked', status: 403 },
  'licence-in-use': { problem: 'licence-in-use', status: 409 },
  'update-needed': { problem: 'update-needed', status: 426 },
  'rate-limited': { problem: 'rate-limited', status: 429 },
};

const UNREACHABLE = { problem: 'relay-unreachable', status: 424 } as const;

export type RegisterResult =
  | { ok: true; registration: TunnelRegistration }
  | { ok: false; problem: RelayConnectProblem; status: number };

function apex(relayUrl: string, path: string): string {
  return new URL(path, relayUrl).toString();
}

/** `POST /register { licenceKey, takeOver? }` → the PC's registration, or why not. */
export async function registerWithRelay(
  relayUrl: string,
  body: { licenceKey: string; takeOver?: boolean },
): Promise<RegisterResult> {
  let res: Response;
  try {
    res = await fetch(apex(relayUrl, '/register'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TUNNEL_VERSION_HEADER]: String(TUNNEL_PROTOCOL_VERSION),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, ...UNREACHABLE };
  }
  const answer: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const registration = tunnelRegistrationSchema.safeParse(answer);
    return registration.success
      ? { ok: true, registration: registration.data }
      : { ok: false, ...UNREACHABLE };
  }
  const code = (answer as { error?: unknown } | null)?.error;
  const known = typeof code === 'string' ? REGISTER_PROBLEMS[code] : undefined;
  return { ok: false, ...(known ?? UNREACHABLE) };
}

/**
 * `POST /unregister` with the registration's credentials. Best effort (ADR 0025): true if
 * the relay let the licence go, false if it couldn't be reached or refused.
 */
export async function unregisterFromRelay(relayUrl: string, record: RelayRecord): Promise<boolean> {
  try {
    const res = await fetch(apex(relayUrl, '/unregister'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${record.secret}`,
        [TUNNEL_KIOSK_HEADER]: record.kioskId,
        [TUNNEL_VERSION_HEADER]: String(TUNNEL_PROTOCOL_VERSION),
      },
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
