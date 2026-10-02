/**
 * Types of rows in the `events` table: the audit trail behind "who approved that?" and
 * the activity feed (specs 002 and 003). These are stored, so never rename one.
 */
export const ACTIVITY_TYPES = [
  // Parent actions on chores (spec 002)
  'instance.claimed',
  'instance.approved',
  'instance.sent_back',
  'instance.marked_done',
  'instance.undone',
  'child.adjusted',
  'surprise.sent',
  // Setup and editing (spec 003)
  'setup.completed',
  'chore.created',
  'chore.updated',
  'chore.deleted',
  'chore.day_toggled',
  'chore.skipped',
  'chore.restored',
  'child.created',
  'child.updated',
  'child.removed',
  'settings.updated',
  'device.paired',
  'device.revoked',
  // Money and jars (spec 004)
  'payday.ran',
  'envelope.sent',
  'envelope.opened',
  'money.spent',
  'goal.created',
  'goal.updated',
  'goal.price_checked',
  'goal.deleted',
  'goal.smashed',
  'goal.unsmashed',
  'goal.bought',
  // System
  'day.scheduled',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
