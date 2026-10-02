/**
 * Claiming a quest on the kiosk (spec 001, "Claiming a quest"): who may claim, what the
 * kiosk plays afterwards, and the send-back note a claim clears. Pure functions.
 */
import type { ChoreStage } from './chores';
import { SEND_BACK_REASONS, type SendBackReason } from './schemas';

/** Why the server refuses a claim. Each maps to an HTTP status in the claim route. */
export type ClaimProblem = 'wrong-child' | 'not-open' | 'not-today';

export interface ClaimableInstance {
  childId: number;
  status: 'open' | 'claimed' | 'approved' | 'skipped';
  /** The instance's date, `YYYY-MM-DD` in the family time zone. */
  date: string;
}

/**
 * Checks a child's claim, most important first: a child claims only their own copy, shared chores included (ADR 0003); only
 * an open quest can be claimed; and only today's (yesterday's leftovers stay unclaimed).
 * Returns null when the claim is allowed.
 */
export function claimProblem(
  instance: ClaimableInstance,
  claim: { childId: number; today: string },
): ClaimProblem | null {
  if (instance.childId !== claim.childId) return 'wrong-child';
  if (instance.status !== 'open') return 'not-open';
  if (instance.date !== claim.today) return 'not-today';
  return null;
}

/** What the kiosk plays when a claim lands: a fanfare and confetti in bonus time, else a pop. */
export function claimFeedback(stageAtClaim: ChoreStage): {
  sound: 'fanfare' | 'pop';
  confetti: boolean;
} {
  return stageAtClaim === 'bonus'
    ? { sound: 'fanfare', confetti: true }
    : { sound: 'pop', confetti: false };
}

/** The note on a sent-back quest card: "↩️ Mum says: Needs a redo" (spec 002). */
export function sendBackNote(reason: SendBackReason, parentName: string | null): string {
  const text = SEND_BACK_REASONS[reason];
  return parentName ? `↩️ ${parentName} says: ${text}` : `↩️ Sent back: ${text}`;
}
