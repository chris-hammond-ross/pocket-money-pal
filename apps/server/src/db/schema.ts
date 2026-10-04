import type { SurpriseRunStatus, Weekday } from '@pmp/shared';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const timestamps = {
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
};

/*
 * Conventions:
 * - Money is integer cents and points are integers.
 * - Domain instants (claims, approvals, ledger rows, events) are epoch milliseconds in
 *   integer columns, set by the code from its clock so they can be tested.
 * - Chore times are "HH:MM" and dates "YYYY-MM-DD", both in the family time zone.
 */

/** Single-row table (id = 1) holding family-wide configuration. */
export const familySettings = sqliteTable('family_settings', {
  id: integer('id').primaryKey(),
  familyName: text('family_name').notNull().default('Our Family'),
  currency: text('currency').notNull().default('GBP'),
  /** Integer cents earned per point. */
  centsPerPoint: integer('cents_per_point').notNull().default(5),
  timezone: text('timezone').notNull().default('Europe/London'),
  /** Kiosk sound volume, 0–100 (DEFAULT_VOLUME in @pmp/shared). */
  volume: integer('volume').notNull().default(80),
  /** Holiday pause (ADR 0004): no chores are created from this date… */
  pausedFrom: text('paused_from'),
  /** …to this date, inclusive. Null with `pausedFrom` set means until resumed. */
  pausedUntil: text('paused_until'),
  /** Quiet hours (ADR 0009): no push from this time… ("HH:MM"; both null = off) */
  quietFrom: text('quiet_from').default('20:00'),
  /** …until this time (exclusive). May be earlier than `quietFrom` (past midnight). */
  quietUntil: text('quiet_until').default('07:00'),
  /** Weekly payday (spec 004): 0 = Sunday … 6 = Saturday. */
  paydayDay: integer('payday_day').notNull().default(0),
  /** Payday's time, "HH:00" in the family time zone. */
  paydayTime: text('payday_time').notNull().default('18:00'),
  /** Payday starts by itself at its time; otherwise a parent presses start (ADR 0010). */
  paydayAuto: integer('payday_auto', { mode: 'boolean' }).notNull().default(true),
  /** When the payday day or time last changed (epoch ms): earlier slots never run. */
  paydayChangedAt: integer('payday_changed_at'),
  ...timestamps,
});

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  role: text('role', { enum: ['parent', 'child'] }).notNull(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  colour: text('colour'),
  /** Children only (3–17): used for library suggestions and shown on the player card. */
  age: integer('age'),
  /** Unused since ADR 0008 (no PINs); kept in case children's optional PINs come back. */
  pinHash: text('pin_hash'),
  /** Left-to-right order of children's kiosk columns. */
  sortOrder: integer('sort_order').notNull().default(0),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  /** Children only: a parent made this date a sick day, so its quests are skipped (ADR 0012). */
  sickOn: text('sick_on'),
  ...timestamps,
});

/** Chore templates. The scheduler turns them into daily instances. */
export const chores = sqliteTable('chores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  icon: text('icon').notNull(),
  /** Library item it came from, if any (so "+ New quest" can hide ones the family has). */
  libraryId: text('library_id'),
  /** "TOGETHER": a label only; each child still gets full points (ADR 0003). */
  together: integer('together', { mode: 'boolean' }).notNull().default(false),
  bonusBefore: text('bonus_before').notNull(),
  dueBy: text('due_by').notNull(),
  lateAfter: text('late_after').notNull(),
  basePoints: integer('base_points').notNull(),
  earlyBonus: integer('early_bonus').notNull().default(0),
  unpromptedBonus: integer('unprompted_bonus').notNull().default(0),
  /** Stored positive; taken off when late. */
  latePenalty: integer('late_penalty').notNull().default(0),
  /** Weekdays it runs on, as a JSON array ("mon"…"sun"). Empty for a one-off. */
  days: text('days', { mode: 'json' }).$type<Weekday[]>().notNull().default([]),
  /** Set for a one-off chore that runs on this date only. */
  oneOffDate: text('one_off_date'),
  /** "Skip today only": the date it was skipped on. Stale dates mean nothing. */
  skippedOn: text('skipped_on'),
  /** Soft delete (epoch ms): history and ledger rows keep pointing at it. */
  deletedAt: integer('deleted_at'),
  /**
   * The surprise run whose grab made this one-off (spec 006). The Day and Week tabs, the
   * quest list and streaks leave these out: the run's own row stands for it.
   */
  surpriseRunId: integer('surprise_run_id').references((): AnySQLiteColumn => surpriseRuns.id),
  ...timestamps,
});

/** Which children a chore is given to (many-to-many). */
export const choreAssignments = sqliteTable(
  'chore_assignments',
  {
    choreId: integer('chore_id')
      .notNull()
      .references(() => chores.id),
    childId: integer('child_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.choreId, t.childId] }),
    index('assignments_child').on(t.childId),
  ],
);

export const INSTANCE_STATUSES = ['open', 'claimed', 'approved', 'skipped'] as const;

/**
 * One chore, for one child, on one day. Times and loot are copied from the chore when the
 * instance is created (ADR 0004), so later edits never rewrite history.
 */
export const choreInstances = sqliteTable(
  'chore_instances',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    choreId: integer('chore_id')
      .notNull()
      .references(() => chores.id),
    childId: integer('child_id')
      .notNull()
      .references(() => users.id),
    date: text('date').notNull(),
    status: text('status', { enum: INSTANCE_STATUSES }).notNull().default('open'),

    bonusBefore: text('bonus_before').notNull(),
    dueBy: text('due_by').notNull(),
    lateAfter: text('late_after').notNull(),
    basePoints: integer('base_points').notNull(),
    earlyBonus: integer('early_bonus').notNull(),
    unpromptedBonus: integer('unprompted_bonus').notNull(),
    latePenalty: integer('late_penalty').notNull(),

    claimedAt: integer('claimed_at'),
    /** The child's "I did it without being asked". */
    unprompted: integer('unprompted', { mode: 'boolean' }),
    /** Why a parent sent it back (a SEND_BACK_REASONS key). Cleared on the next claim. */
    sendBackReason: text('send_back_reason'),
    /** The parent who sent it back ("Mum says: …"). Cleared with the reason. */
    sentBackBy: integer('sent_back_by').references(() => users.id),

    approvedAt: integer('approved_at'),
    approvedBy: integer('approved_by').references(() => users.id),
    /** Itemised points awarded at approval (a PointsBreakdown). Late is stored positive. */
    awardedBase: integer('awarded_base'),
    awardedEarly: integer('awarded_early'),
    awardedUnprompted: integer('awarded_unprompted'),
    awardedLate: integer('awarded_late'),
    awardedExtra: integer('awarded_extra'),
    awardedTotal: integer('awarded_total'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('instances_chore_child_date').on(t.choreId, t.childId, t.date),
    index('instances_date').on(t.date),
  ],
);

export const LEDGER_KINDS = [
  'chore_points',
  'bonus',
  'penalty',
  'conversion',
  'extra_income',
  'goal_allocation',
  'spend',
  'adjustment',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/**
 * Append-only: triggers in the migration refuse UPDATE and DELETE. Balances are sums.
 * An undo is a new row with the opposite amounts, the same kind, and `reversesId` set.
 */
export const ledger = sqliteTable(
  'ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    childId: integer('child_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: LEDGER_KINDS }).notNull(),
    points: integer('points').notNull().default(0),
    cents: integer('cents').notNull().default(0),
    /** The family rate when a row with points was written (ADR 0004). */
    centsPerPoint: integer('cents_per_point'),
    instanceId: integer('instance_id').references(() => choreInstances.id),
    /** The jar a `goal_allocation` or `spend` row is about (spec 004). */
    goalId: integer('goal_id').references((): AnySQLiteColumn => goals.id),
    /** The payday a `conversion` row (or an envelope opened by it) belongs to. */
    paydayId: integer('payday_id').references((): AnySQLiteColumn => paydays.id),
    reversesId: integer('reverses_id').references((): AnySQLiteColumn => ledger.id),
    note: text('note'),
    createdBy: integer('created_by').references(() => users.id),
    at: integer('at').notNull(),
  },
  (t) => [
    index('ledger_child_at').on(t.childId, t.at),
    index('ledger_child_kind').on(t.childId, t.kind),
    index('ledger_instance').on(t.instanceId),
    uniqueIndex('ledger_reverses').on(t.reversesId),
    index('ledger_goal').on(t.goalId),
  ],
);

/**
 * Savings jars (spec 004; the plan's `goals`). A jar's money is the sum of its
 * `goal_allocation` and `spend` ledger rows, never a column.
 */
export const goals = sqliteTable(
  'goals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    childId: integer('child_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    emoji: text('emoji').notNull(),
    targetCents: integer('target_cents').notNull(),
    shopUrl: text('shop_url'),
    /** The shop link's picture, a file name in `images/` next to the database. */
    imagePath: text('image_path'),
    /** Jar order: creation order, new jars last. */
    sortOrder: integer('sort_order').notNull().default(0),
    /** The child (made on the kiosk) or the parent who made it. */
    createdBy: integer('created_by').references(() => users.id),
    /** Null while a kid-made jar's price waits for a parent to check it (epoch ms). */
    priceCheckedAt: integer('price_checked_at'),
    /** The child smashed it: full, waiting for a grown-up to buy it. */
    smashedAt: integer('smashed_at'),
    /** Bought: its money was spent and the jar is finished. */
    boughtAt: integer('bought_at'),
    /** Soft delete (epoch ms): its money went back to "to sort". */
    deletedAt: integer('deleted_at'),
    ...timestamps,
  },
  (t) => [index('goals_child').on(t.childId)],
);

/** Gifts from a phone, waiting on the kiosk as envelopes until opened (spec 004). */
export const envelopes = sqliteTable(
  'envelopes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    childId: integer('child_id')
      .notNull()
      .references(() => users.id),
    cents: integer('cents').notNull(),
    note: text('note').notNull(),
    /** "Grandma", "the Tooth Fairy", or the parent's name. */
    fromName: text('from_name').notNull(),
    createdBy: integer('created_by').references(() => users.id),
    /** When it was sent (epoch ms). */
    sentAt: integer('sent_at').notNull(),
    openedAt: integer('opened_at'),
    /** The `extra_income` row written when it was opened. */
    ledgerId: integer('ledger_id').references((): AnySQLiteColumn => ledger.id),
    ...timestamps,
  },
  (t) => [index('envelopes_child').on(t.childId)],
);

/** One row per payday run (spec 004, ADR 0010). The show's summary is derived. */
export const paydays = sqliteTable('paydays', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** The slot it covers (epoch ms). A slot is covered at most once. */
  at: integer('at').notNull().unique(),
  /** When it actually ran (epoch ms). */
  ranAt: integer('ran_at').notNull(),
  /** The parent who pressed start, or null when it started by itself. */
  startedBy: integer('started_by').references(() => users.id),
  ...timestamps,
});

export const STREAK_RESULTS = ['done', 'missed', 'neutral', 'pending'] as const;

/**
 * Each child's result for each past day that had chores (spec 005, ADR 0012). A cache of
 * what `chore_instances` says, so a streak needn't scan every past day: rebuilding it from
 * the instances gives the same rows. Days with no chores have no row (they're neutral).
 */
export const streakDays = sqliteTable(
  'streak_days',
  {
    childId: integer('child_id')
      .notNull()
      .references(() => users.id),
    date: text('date').notNull(),
    result: text('result', { enum: STREAK_RESULTS }).notNull(),
    /** When this result was decided (epoch ms). */
    decidedAt: integer('decided_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.childId, t.date] })],
);

/** The family's saved surprise quests (spec 006; the plan's `surprise_tasks`). */
export const surpriseTasks = sqliteTable('surprise_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  icon: text('icon').notNull(),
  rewardPoints: integer('reward_points').notNull(),
  /** Default time frame: how long it stays up on the kiosk to be accepted. */
  timeFrameMin: integer('time_frame_min').notNull(),
  /** Default who: one child, or null for all children. */
  childId: integer('child_id').references(() => users.id),
  /** Soft delete (epoch ms): runs already sent keep their own copy anyway. */
  deletedAt: integer('deleted_at'),
  ...timestamps,
});

export const SURPRISE_RUN_STATUS_VALUES = [
  'scheduled',
  'queued',
  'live',
  'grabbed',
  'expired',
  'cancelled',
] as const satisfies readonly SurpriseRunStatus[];

/**
 * One row per surprise sent (spec 006): `scheduled` → `queued` → `live` → `grabbed` |
 * `expired` | `cancelled`. It copies its quest when it's made, so editing or deleting the
 * saved quest never changes it. After the grab, progress lives on the one-off chore's
 * instances (`chore_id`).
 */
export const surpriseRuns = sqliteTable(
  'surprise_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The saved quest it came from; null for a new one that wasn't kept. */
    taskId: integer('task_id').references(() => surpriseTasks.id),
    title: text('title').notNull(),
    icon: text('icon').notNull(),
    rewardPoints: integer('reward_points').notNull(),
    timeFrameMin: integer('time_frame_min').notNull(),
    /** One child, or null for all children. */
    childId: integer('child_id').references(() => users.id),
    status: text('status', { enum: SURPRISE_RUN_STATUS_VALUES }).notNull(),
    /** The family date it's for: surprises are today only. */
    date: text('date').notNull(),
    /** A set time (epoch ms); null when sent right away. */
    appearAt: integer('appear_at'),
    /** When it was sent or last changed on a phone (epoch ms): the queue's order. */
    sentAt: integer('sent_at').notNull(),
    /** When it went live, and when its time frame runs out (epoch ms). */
    shownAt: integer('shown_at'),
    expiresAt: integer('expires_at'),
    grabbedAt: integer('grabbed_at'),
    /** "We'll all do it!": every eligible child took it. */
    team: integer('team', { mode: 'boolean' }).notNull().default(false),
    /** When it was grabbed, expired or cancelled (epoch ms). */
    endedAt: integer('ended_at'),
    /** Who sent it: `phone` (a parent), or `ha` later (Phase 7). */
    source: text('source', { enum: ['phone', 'ha'] })
      .notNull()
      .default('phone'),
    sentBy: integer('sent_by').references(() => users.id),
    cancelledBy: integer('cancelled_by').references(() => users.id),
    /** The one-off chore the grab made. */
    choreId: integer('chore_id').references((): AnySQLiteColumn => chores.id),
    ...timestamps,
  },
  (t) => [index('surprise_runs_status').on(t.status), index('surprise_runs_date').on(t.date)],
);

/** Audit trail and activity feed: every parent action and notable system action. */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    type: text('type').notNull(),
    /** Who did it (a parent, or a child claiming); null for the system. */
    actorId: integer('actor_id').references(() => users.id),
    childId: integer('child_id').references(() => users.id),
    choreId: integer('chore_id').references(() => chores.id),
    /** No foreign key: open instances can be deleted, but their history stays. */
    instanceId: integer('instance_id'),
    /** Extra detail (a reason, a short diff), as JSON. */
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [index('events_at').on(t.at)],
);

/** Paired parent phones (Phase 3). Only a hash of the token is stored. */
export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  /** Web Push subscription (ADR 0002), when the phone opted in over HTTPS. */
  pushSubscription: text('push_subscription', { mode: 'json' }).$type<Record<string, unknown>>(),
  lastSeenAt: integer('last_seen_at'),
  revokedAt: integer('revoked_at'),
  ...timestamps,
});

/**
 * Single-row (id = 1) draft of first-run setup, so a reload keeps players and quests. It
 * also holds the one-time setup token shown in the kiosk's QR code (ADR 0005). The row is
 * deleted when setup completes.
 */
export const setupDrafts = sqliteTable('setup_drafts', {
  id: integer('id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  token: text('token'),
  ...timestamps,
});

/**
 * Short-lived codes that pair a new phone (ADR 0008): made by a paired phone's "Pair
 * another phone", or by the PC while no phone is paired. Only a hash is stored. A code
 * works once, until `expires_at`.
 */
export const pairingCodes = sqliteTable('pairing_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  codeHash: text('code_hash').notNull().unique(),
  /** The phone that asked for it; null for the PC's code. */
  createdByDevice: integer('created_by_device').references(() => devices.id),
  /**
   * A move code (ADR 0009): pairing with it revokes this device, the same phone moving
   * from its http:// address to the HTTPS one.
   */
  replacesDevice: integer('replaces_device').references(() => devices.id),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  ...timestamps,
});

/**
 * Server-wide values that aren't family settings (ADR 0009): the VAPID key pair for Web
 * Push, and the HTTPS address the server was last reached on.
 */
export const serverKv = sqliteTable('server_kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  ...timestamps,
});
