/**
 * Push notifications for claimed chores (spec 003 "Notifications", ADR 0009): quiet hours
 * and the notification text. Pure functions; the server does the batching and sending.
 */
import { parseTimeOfDay } from './time';

/** Claims within this long of the first one go out as one notification (spec 003). */
export const PUSH_BATCH_MS = 2 * 60_000;

/** The notification tag: a later batch replaces the earlier notification, not adds one. */
export const CLAIM_PUSH_TAG = 'claims';

/** Where tapping a claim notification leads: the phone, with the tray open. */
export const CLAIM_PUSH_URL = '/parent?tray=1';

export const DEFAULT_QUIET_HOURS = { from: '20:00', until: '07:00' } as const;

export interface QuietHours {
  from: string;
  until: string;
}

/**
 * Whether `time` ("HH:MM", family time zone) is inside quiet hours. The window may run
 * past midnight (20:00–07:00). `from` is included and `until` isn't. Equal times mean the
 * window is empty. Null quiet hours are never quiet.
 */
export function isQuietTime(quiet: QuietHours | null, time: string): boolean {
  if (!quiet) return false;
  const t = parseTimeOfDay(time);
  const from = parseTimeOfDay(quiet.from);
  const until = parseTimeOfDay(quiet.until);
  if (from === until) return false;
  return from < until ? t >= from && t < until : t >= from || t < until;
}

export interface PushClaim {
  childName: string;
  title: string;
}

/**
 * The text of a claim notification. `claims` are the batch's claims still waiting, oldest
 * first; `waiting` is everything in the tray. One claim names the quest; several name the
 * children ("Alice and Billy claimed 3 quests").
 */
export function claimPushText(
  claims: readonly PushClaim[],
  waiting: number,
): { title: string; body: string } {
  const body = `${waiting} to check · tap to approve`;
  if (claims.length === 1) {
    const [claim] = claims;
    return { title: `${claim!.childName} claimed ‘${claim!.title}’`, body };
  }
  const names = [...new Set(claims.map((c) => c.childName))];
  const who =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return { title: `${who} claimed ${claims.length} quests`, body };
}

/** Where tapping a money notification leads: the phone's Payday tab. */
export const PAYDAY_PUSH_URL = '/parent?tab=payday';

/** "Payday is ready" in "When I press start" mode (spec 004, ADR 0010). */
export function paydayReadyPushText(): { title: string; body: string; tag: string } {
  return {
    title: "💰 It's payday!",
    body: 'Start it when the kids are ready.',
    tag: 'payday',
  };
}

/** A child smashed a full jar (ADR 0010). `amount` is already formatted ("£24.99"). */
export function smashPushText(
  childName: string,
  jarName: string,
  amount: string,
): { title: string; body: string; tag: string } {
  return {
    title: `🔨 ${childName} smashed the ${jarName} jar`,
    body: `${amount} ready · needs buying`,
    tag: 'smash',
  };
}
