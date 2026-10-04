import { z } from 'zod';
import { LIBRARY_SECTIONS } from './library';
import { normalisePairingCode } from './pairing';
import { NOTE_MAX } from './payday';
import { JAR_EMOJI_LIST, JAR_MAX_CENTS, JAR_MIN_CENTS, JAR_NAME_MAX } from './savings';
import { isIsoDate, isValidTimeZone, parseTimeOfDay, WEEKDAYS } from './time';

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. GBP');

export const timeZoneSchema = z
  .string()
  .min(1)
  .refine(isValidTimeZone, 'Unknown time zone, e.g. Europe/London');

/** Whole cents per point. Setup offers 1p–20p; anything up to £100 a point is accepted. */
export const centsPerPointSchema = z.number().int().min(1).max(10_000);

export const isoDateSchema = z.string().refine(isIsoDate, 'Expected a date as YYYY-MM-DD');

/** Holiday pause: no chores on dates from `from` to `until` (inclusive; null = open-ended). */
export const schedulePauseSchema = z
  .object({ from: isoDateSchema, until: isoDateSchema.nullable() })
  .refine((p) => p.until === null || p.until >= p.from, {
    path: ['until'],
    message: 'The pause must end on or after it starts',
  });
export type SchedulePauseInput = z.infer<typeof schedulePauseSchema>;

/** Sound volume on the kiosk, from 0 (silent) to 100. */
export const volumeSchema = z.number().int().min(0).max(100);
export const DEFAULT_VOLUME = 80;

export const familySettingsSchema = z.object({
  familyName: z.string().min(1).max(60),
  currency: currencySchema,
  centsPerPoint: z.number().int().min(0).max(10_000),
  timezone: z.string().min(1),
  volume: volumeSchema,
  pause: z.object({ from: z.string(), until: z.string().nullable() }).nullable(),
  /** No push in this window, family time zone (ADR 0009). Null when off. */
  quietHours: z.object({ from: z.string(), until: z.string() }).nullable(),
  /** Weekly payday (spec 004): day 0 = Sunday, "HH:MM", and whether it starts by itself. */
  payday: z.object({ day: z.number().int(), time: z.string(), auto: z.boolean() }),
});
export type FamilySettings = z.infer<typeof familySettingsSchema>;

export const familySettingsPatchSchema = z
  .object({
    familyName: z.string().trim().min(1).max(60),
    currency: currencySchema,
    centsPerPoint: centsPerPointSchema,
    timezone: timeZoneSchema,
    volume: volumeSchema,
    /** Set a holiday pause, or null to resume. */
    pause: schedulePauseSchema.nullable(),
    /** Quiet hours, or null for none. */
    quietHours: z.lazy(() => quietHoursSchema).nullable(),
    paydayDay: z.number().int().min(0).max(6),
    paydayTime: z.lazy(() => paydayTimeSchema),
    paydayAuto: z.boolean(),
  })
  .partial();
export type FamilySettingsPatch = z.infer<typeof familySettingsPatchSchema>;

/** Payday's time: on the hour (spec 004). */
export const paydayTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):00$/, 'Payday is on the hour, as HH:00');

/**
 * `PATCH /api/settings` from a phone: the loot rate (from now on), quiet hours and the kiosk
 * volume on the Players tab, and payday's day, time and how it starts on the Payday tab.
 */
export const phoneSettingsPatchSchema = z
  .object({
    centsPerPoint: centsPerPointSchema,
    /** The kiosk's sound volume (spec 005). */
    volume: volumeSchema,
    quietHours: z.lazy(() => quietHoursSchema).nullable(),
    paydayDay: z.number().int().min(0).max(6),
    paydayTime: paydayTimeSchema,
    paydayAuto: z.boolean(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');
export type PhoneSettingsPatch = z.infer<typeof phoneSettingsPatchSchema>;

export const healthSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptimeSeconds: z.number(),
  /** The web build being served, and the API version (ADR 0011). */
  build: z.string().nullable(),
  apiVersion: z.number().int(),
});
export type Health = z.infer<typeof healthSchema>;

export const pingRequestSchema = z.object({
  from: z.string().min(1).max(40),
});
export type PingRequest = z.infer<typeof pingRequestSchema>;

// ---------------------------------------------------------------------------
// Building blocks

export const idSchema = z.number().int().positive();

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:MM" on a 15-minute step, as the quest editor's markers snap (spec 003). */
export const timeOfDaySchema = z
  .string()
  .regex(HH_MM, 'Expected a time as HH:MM')
  // Zod 4 still runs refinements after a failed regex, so guard before parsing.
  .refine((t) => !HH_MM.test(t) || parseTimeOfDay(t) % 15 === 0, 'Times go in 15-minute steps');

export const weekdaySchema = z.enum(WEEKDAYS);

/** Quiet hours (ADR 0009): "HH:MM" on 15-minute steps; may run past midnight. */
export const quietHoursSchema = z
  .object({ from: timeOfDaySchema, until: timeOfDaySchema })
  .refine((q) => q.from !== q.until, {
    path: ['until'],
    message: 'Quiet hours must end at a different time',
  });

export const colourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a colour like #228be6');

/** An emoji (or short text) used as an avatar or chore icon. */
export const iconSchema = z.string().trim().min(1).max(16);

const pointsSchema = z.number().int().min(0).max(1000);

// ---------------------------------------------------------------------------
// People

export const childInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the player a name').max(14),
  age: z.number().int().min(3).max(17),
  avatar: iconSchema,
  colour: colourSchema,
});
export type ChildInput = z.infer<typeof childInputSchema>;

/** `PATCH /api/children/:id`: any of the player editor's fields. */
export const childPatchSchema = childInputSchema.partial().strict();
export type ChildPatch = z.infer<typeof childPatchSchema>;

/** A grown-up. There are no PINs: parents act from paired phones (ADR 0008). */
export const parentInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the grown-up a name').max(30),
});
export type ParentInput = z.infer<typeof parentInputSchema>;

// ---------------------------------------------------------------------------
// Chores

const choreFields = {
  title: z.string().trim().min(1, 'Give the quest a title').max(40),
  icon: iconSchema,
  /** Shared job: with two or more players, each child gets the full points (ADR 0003). */
  together: z.boolean().default(false),
  bonusBefore: timeOfDaySchema,
  dueBy: timeOfDaySchema,
  lateAfter: timeOfDaySchema,
  basePoints: pointsSchema,
  earlyBonus: pointsSchema,
  unpromptedBonus: pointsSchema,
  latePenalty: pointsSchema,
  /** Weekdays it runs on. Empty for a one-off. */
  days: z.array(weekdaySchema).max(7),
  /** Set for a one-off chore that runs on this date only. */
  oneOffDate: isoDateSchema.nullable().default(null),
};

interface ChoreRuleFields {
  bonusBefore: string;
  dueBy: string;
  lateAfter: string;
  days: string[];
  oneOffDate: string | null;
  together: boolean;
}

function checkChore(chore: ChoreRuleFields, players: readonly unknown[], ctx: z.RefinementCtx) {
  const [bonus, due, late] = [chore.bonusBefore, chore.dueBy, chore.lateAfter].map((t) =>
    HH_MM.test(t) ? parseTimeOfDay(t) : NaN,
  );
  if (bonus! > due!) {
    ctx.addIssue({
      code: 'custom',
      path: ['bonusBefore'],
      message: 'Bonus must end by the due time',
    });
  }
  if (due! > late!) {
    ctx.addIssue({ code: 'custom', path: ['lateAfter'], message: 'Late must be at or after due' });
  }
  if (new Set(chore.days).size !== chore.days.length) {
    ctx.addIssue({ code: 'custom', path: ['days'], message: 'A day is listed twice' });
  }
  if (chore.oneOffDate === null && chore.days.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['days'], message: 'Pick at least one day' });
  }
  if (chore.oneOffDate !== null && chore.days.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['days'], message: 'A one-off has no repeat days' });
  }
  if (new Set(players).size !== players.length) {
    ctx.addIssue({ code: 'custom', path: ['players'], message: 'A player is listed twice' });
  }
  if (chore.together && players.length < 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['together'],
      message: 'Together needs two or more players',
    });
  }
}

/** Create or replace a chore (phone quest editor). */
export const choreInputSchema = z
  .object({ ...choreFields, childIds: z.array(idSchema).min(1, 'Pick at least one player') })
  .superRefine((c, ctx) => checkChore(c, c.childIds, ctx));
export type ChoreInput = z.infer<typeof choreInputSchema>;

export const instanceStatusSchema = z.enum(['open', 'claimed', 'approved', 'skipped']);
export type InstanceStatus = z.infer<typeof instanceStatusSchema>;

// ---------------------------------------------------------------------------
// Claims and approvals (spec 002)

/**
 * `POST /api/instances/:id/claim`. `childId` is the column the child tapped in: the server
 * refuses the claim unless the instance is that child's, so a stale screen can't claim
 * someone else's chore.
 */
export const claimRequestSchema = z.object({ childId: idSchema, unprompted: z.boolean() });
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const choreStageSchema = z.enum(['bonus', 'due', 'overdue', 'late']);

export const pointsBreakdownSchema = z.object({
  base: z.number().int(),
  early: z.number().int(),
  unprompted: z.number().int(),
  late: z.number().int(),
  extra: z.number().int(),
  total: z.number().int(),
});

/**
 * A claim that landed: the claim route's answer, and the payload of the `instance.claimed`
 * event that every screen animates from.
 */
export const claimResultSchema = z.object({
  instanceId: idSchema,
  childId: idSchema,
  claimedAt: z.number().int(),
  unprompted: z.boolean(),
  /** The stage when it was claimed: bonus time gets a fanfare and confetti. */
  stage: choreStageSchema,
  /** The points worked out at claim time ("+N pending"). */
  points: pointsBreakdownSchema,
});
export type ClaimResult = z.infer<typeof claimResultSchema>;

export const approveRequestSchema = z.object({
  items: z
    .array(
      z.object({
        id: idSchema,
        /** The parent's chips. Each one left out takes the claim's default (`defaultChips`). */
        early: z.boolean().optional(),
        unprompted: z.boolean().optional(),
        late: z.boolean().optional(),
        extra: z.number().int().min(-1000).max(1000).default(0),
      }),
    )
    .min(1)
    .max(200)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'Duplicate chore'),
});
export type ApproveRequest = z.infer<typeof approveRequestSchema>;

export const SEND_BACK_REASONS = {
  not_finished: 'Not finished yet',
  needs_redo: 'Needs a redo',
  do_together: "Let's do it together",
  didnt_happen: "Didn't happen",
} as const;
export const sendBackReasonSchema = z.enum(
  Object.keys(SEND_BACK_REASONS) as [
    keyof typeof SEND_BACK_REASONS,
    ...(keyof typeof SEND_BACK_REASONS)[],
  ],
);
export type SendBackReason = z.infer<typeof sendBackReasonSchema>;

export const sendBackRequestSchema = z.object({ reason: sendBackReasonSchema });

export const adjustRequestSchema = z.object({
  points: z
    .number()
    .int()
    .min(-1000)
    .max(1000)
    .refine((p) => p !== 0, 'Points must not be zero'),
  note: z.string().trim().max(100).optional(),
});
export type AdjustRequest = z.infer<typeof adjustRequestSchema>;

// ---------------------------------------------------------------------------
// First-run setup (spec 003). Children don't have ids yet, so chores refer to them by a
// client-chosen key.

const clientKeySchema = z.string().min(1).max(40);
const libraryIdSchema = z.string().regex(/^[a-z0-9-]+$/);

export const setupChildSchema = childInputSchema.extend({ key: clientKeySchema });
export type SetupChild = z.infer<typeof setupChildSchema>;

export const setupChoreSchema = z
  .object({
    ...choreFields,
    /** The page's own id for the quest while it's a draft. */
    key: clientKeySchema.optional(),
    /** The library suggestion it came from, if any (stored as `chores.library_id`). */
    libraryId: libraryIdSchema.nullable().default(null),
    childKeys: z.array(clientKeySchema).min(1, 'Pick at least one player'),
  })
  .superRefine((c, ctx) => checkChore(c, c.childKeys, ctx));
export type SetupChore = z.infer<typeof setupChoreSchema>;

const MAX_SETUP_PARENTS = 6;
const MAX_SETUP_CHILDREN = 12;
const MAX_SETUP_CHORES = 200;

export const setupRequestSchema = z
  .object({
    parents: z.array(parentInputSchema).min(1).max(MAX_SETUP_PARENTS),
    children: z.array(setupChildSchema).min(1, 'Add at least one player').max(MAX_SETUP_CHILDREN),
    chores: z.array(setupChoreSchema).min(1, 'Hand out at least one quest').max(MAX_SETUP_CHORES),
    centsPerPoint: centsPerPointSchema,
    /** The finishing browser's time zone (ADR 0005). Omitted keeps the current setting. */
    timezone: timeZoneSchema.optional(),
  })
  .superRefine((setup, ctx) => {
    const parentNames = setup.parents.map((p) => p.name.toLocaleLowerCase());
    if (new Set(parentNames).size !== parentNames.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['parents'],
        message: 'Each grown-up needs a different name.',
      });
    }
    const names = setup.children.map((c) => c.name.toLocaleLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        message: 'Two players have the same name',
      });
    }
    const keys = new Set(setup.children.map((c) => c.key));
    if (keys.size !== setup.children.length) {
      ctx.addIssue({ code: 'custom', path: ['children'], message: 'Duplicate player key' });
    }
    setup.chores.forEach((chore, i) => {
      if (chore.childKeys.some((k) => !keys.has(k))) {
        ctx.addIssue({
          code: 'custom',
          path: ['chores', i, 'childKeys'],
          message: 'Unknown player',
        });
      }
    });
  });
export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type SetupRequestInput = z.input<typeof setupRequestSchema>;

/** Setup stages after the title screen (spec 003). */
export const SETUP_STAGES = ['title', 'masters', 'players', 'quests', 'board'] as const;
export type SetupStage = (typeof SETUP_STAGES)[number];

/**
 * Setup in progress, saved server-side as it's made so a reload keeps it (ADR 0005).
 * Looser than the final request: empty lists
 * are fine, and cross-checks wait for `setupRequestSchema`.
 */
export const setupDraftSchema = z.object({
  stage: z.enum(SETUP_STAGES),
  parentNames: z.array(z.string().max(30)).max(MAX_SETUP_PARENTS),
  children: z.array(setupChildSchema).max(MAX_SETUP_CHILDREN),
  chores: z.array(setupChoreSchema).max(MAX_SETUP_CHORES),
  centsPerPoint: centsPerPointSchema,
});
export type SetupDraft = z.infer<typeof setupDraftSchema>;

/** `GET /api/setup/draft`. */
export const setupDraftResponseSchema = z.object({ draft: setupDraftSchema.nullable() });

export const setupStatusSchema = z.object({
  needed: z.boolean(),
  /** The request came from the family PC itself, which needs no setup token (ADR 0005). */
  onPc: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** What the kiosk's title screen needs to draw the setup QR code (PC only). */
export const setupKioskInfoSchema = z.object({
  token: z.string(),
  /** The PC's likely home-network addresses, best first. */
  hosts: z.array(z.string()),
  /** `PMP_PUBLIC_URL`, when set, replaces the guessed address. */
  publicUrl: z.string().nullable(),
});
export type SetupKioskInfo = z.infer<typeof setupKioskInfoSchema>;

export const setupResultSchema = z.object({
  parentId: idSchema,
  /** This device was paired to the first grown-up (not on the family PC; ADR 0005). */
  paired: z.boolean(),
});
export type SetupResult = z.infer<typeof setupResultSchema>;

/** `GET /api/devices/me`: the parent this device is paired to. */
export const deviceMeSchema = z.object({
  deviceId: idSchema,
  name: z.string(),
  parent: z.object({ id: idSchema, name: z.string() }),
});
export type DeviceMe = z.infer<typeof deviceMeSchema>;

// ---------------------------------------------------------------------------
// Pairing and devices (ADR 0008)

/** A pairing code as typed or scanned ("k7qm-4pxd"), read as its 8 characters. */
export const pairingCodeSchema = z
  .string()
  .max(40)
  .transform((v, ctx) => {
    const code = normalisePairingCode(v);
    if (code === null) {
      ctx.addIssue({ code: 'custom', message: 'That isn’t a pairing code' });
      return z.NEVER;
    }
    return code;
  });

/** `POST /api/devices/pair/check`: is this code good, and for whom can it pair? */
export const pairCheckRequestSchema = z.object({ code: pairingCodeSchema });
export const pairCheckResultSchema = z.object({
  parents: z.array(z.object({ id: idSchema, name: z.string() })),
  expiresAt: z.number().int(),
});
export type PairCheckResult = z.infer<typeof pairCheckResultSchema>;

/** `POST /api/devices/pair`: the new phone says which grown-up it's for. */
export const pairRequestSchema = z.object({ code: pairingCodeSchema, parentId: idSchema });

/** A pairing code for the QR: from a paired phone's invite, or the PC while no phone is paired. */
export const pairingInviteSchema = z.object({
  /** The 8 characters (`formatPairingCode` shows it with a dash). */
  code: z.string(),
  expiresAt: z.number().int(),
  /** The PC's likely home-network addresses, best first (see setupKioskInfoSchema). */
  hosts: z.array(z.string()),
  publicUrl: z.string().nullable(),
});
export type PairingInvite = z.infer<typeof pairingInviteSchema>;

/** `GET /api/devices`: every paired (not revoked) device. */
export const deviceListSchema = z.array(
  z.object({
    id: idSchema,
    name: z.string(),
    parent: z.object({ id: idSchema, name: z.string() }),
    pairedAt: z.string(),
    lastSeenAt: z.number().int().nullable(),
    /** The device asking. */
    current: z.boolean(),
  }),
);
export type DeviceList = z.infer<typeof deviceListSchema>;

// ---------------------------------------------------------------------------
// The phone's to-check tray and Day tab (spec 003)

/** One claimed chore waiting in the tray. */
export const trayItemSchema = z.object({
  instanceId: idSchema,
  childId: idSchema,
  /** The child's look, kept for a claim whose player was removed since (ADR 0009). */
  child: z.object({ name: z.string(), avatar: z.string(), colour: z.string() }),
  choreId: idSchema,
  title: z.string(),
  icon: z.string(),
  date: isoDateSchema,
  claimedAt: z.number().int(),
  unprompted: z.boolean(),
  /** The stage when it was claimed, and the points that gives with the default chips. */
  stage: choreStageSchema,
  points: pointsBreakdownSchema,
});
export type TrayItem = z.infer<typeof trayItemSchema>;

/** `GET /api/instances/claimed`, oldest claim first. */
export const trayListSchema = z.array(trayItemSchema);

export const dayInstanceSchema = z.object({
  id: idSchema,
  childId: idSchema,
  status: instanceStatusSchema,
  claimedAt: z.number().int().nullable(),
  unprompted: z.boolean().nullable(),
  /** Claimed: the points at claim time. Approved: the points awarded. Else null. */
  points: z.number().int().nullable(),
  sentBack: z.object({ reason: sendBackReasonSchema, by: z.string().nullable() }).nullable(),
});
export type DayInstance = z.infer<typeof dayInstanceSchema>;

/** A chore as the phone edits it (`GET /api/chores`). */
export const choreSchema = z.object({
  id: idSchema,
  title: z.string(),
  icon: z.string(),
  libraryId: z.string().nullable(),
  together: z.boolean(),
  bonusBefore: z.string(),
  dueBy: z.string(),
  lateAfter: z.string(),
  basePoints: z.number().int(),
  earlyBonus: z.number().int(),
  unpromptedBonus: z.number().int(),
  latePenalty: z.number().int(),
  days: z.array(weekdaySchema),
  oneOffDate: isoDateSchema.nullable(),
  childIds: z.array(idSchema),
});
export type Chore = z.infer<typeof choreSchema>;
export const choreListSchema = z.array(choreSchema);

export const dayQuestSchema = z.object({
  chore: choreSchema,
  /** Today only: "Skip today" is on (its open chores are off the kiosk). */
  skipped: z.boolean(),
  /** Today only: each assigned child's instance (none on other days). */
  instances: z.array(dayInstanceSchema),
});
export type DayQuest = z.infer<typeof dayQuestSchema>;

/** `GET /api/day/:date`. */
export const dayPlanSchema = z.object({
  date: isoDateSchema,
  /** Today in the family time zone. */
  today: isoDateSchema,
  serverNow: z.number().int(),
  timezone: z.string(),
  centsPerPoint: z.number().int(),
  currency: z.string(),
  children: z.array(
    z.object({ id: idSchema, name: z.string(), avatar: z.string(), colour: z.string() }),
  ),
  /** Sorted by due time. */
  quests: z.array(dayQuestSchema),
});
export type DayPlan = z.infer<typeof dayPlanSchema>;

/** `PATCH /api/chores/:id`: any fields; the merged chore must pass `choreInputSchema`. */
export const chorePatchSchema = z
  .object({
    ...choreFields,
    // No defaults here: a field left out keeps its current value.
    together: z.boolean(),
    oneOffDate: isoDateSchema.nullable(),
    childIds: z.array(idSchema),
  })
  .partial()
  .strict();
export type ChorePatch = z.infer<typeof chorePatchSchema>;

/** What an approval tells every screen (the `instance.approved` event). */
export const approvalSchema = z.object({
  instanceId: idSchema,
  childId: idSchema,
  points: pointsBreakdownSchema,
  /** Lifetime XP before and after, so the kiosk can play a level-up. */
  xpBefore: z.number().int(),
  xpAfter: z.number().int(),
  /** Mark done: the parent claimed it for the child and approved it at once. */
  markedDone: z.boolean(),
});
export type Approval = z.infer<typeof approvalSchema>;

// ---------------------------------------------------------------------------
// Chore library (seed suggestions, spec 003)

export const choreLibraryItemSchema = z
  .object({
    ...choreFields,
    id: libraryIdSchema,
    section: z.enum(LIBRARY_SECTIONS),
    minAge: z.number().int().min(3).max(17),
  })
  .superRefine((c, ctx) => checkChore(c, [], ctx));

/** `GET /api/chore-library`. */
export const choreLibrarySchema = z.array(choreLibraryItemSchema);

// ---------------------------------------------------------------------------
// Money and jars (spec 004, ADR 0010). Money is integer cents.

/** A whole number of cents above zero, up to £1,000. */
export const centsAmountSchema = z.number().int().min(1).max(100_000);

export const jarNameSchema = z.string().trim().min(1, 'Give the jar a name').max(JAR_NAME_MAX);
export const jarPriceSchema = z.number().int().min(JAR_MIN_CENTS).max(JAR_MAX_CENTS);
export const jarEmojiSchema = z
  .string()
  .refine((e) => JAR_EMOJI_LIST.includes(e), 'Pick one of the pictures');
const shopUrlSchema = z
  .url({ protocol: /^https?$/, message: 'A shop link starts with http:// or https://' })
  .max(2000);
const moneyNoteSchema = z.string().trim().min(1, 'Add a note').max(NOTE_MAX);

/** `POST /api/goals`: make a jar (kiosk: price not checked; phone: checked). */
export const goalCreateSchema = z
  .object({
    childId: idSchema,
    name: jarNameSchema,
    emoji: jarEmojiSchema,
    targetCents: jarPriceSchema,
    shopUrl: shopUrlSchema.nullable().optional(),
  })
  .strict();
export type GoalCreate = z.infer<typeof goalCreateSchema>;

/** `PATCH /api/goals/:id` (phone): any of these; saving marks the price checked. */
export const goalPatchSchema = z
  .object({
    name: jarNameSchema,
    emoji: jarEmojiSchema,
    targetCents: jarPriceSchema,
    shopUrl: shopUrlSchema.nullable(),
  })
  .partial()
  .strict();
export type GoalPatch = z.infer<typeof goalPatchSchema>;

/** `POST /api/goals/:id/move`: positive pours in from "to sort", negative takes out. */
export const goalMoveSchema = z
  .object({
    cents: z
      .number()
      .int()
      .min(-100_000)
      .max(100_000)
      .refine((c) => c !== 0, 'Move some coins'),
  })
  .strict();

/** `POST /api/children/:id/envelopes`: a gift from the phone. */
export const envelopeCreateSchema = z
  .object({ cents: centsAmountSchema, note: moneyNoteSchema })
  .strict();
export type EnvelopeCreate = z.infer<typeof envelopeCreateSchema>;

/** `POST /api/children/:id/spend`: money out, from "to sort" (no goalId) or a jar. */
export const spendSchema = z
  .object({
    cents: centsAmountSchema,
    note: moneyNoteSchema,
    goalId: idSchema.nullable().optional(),
  })
  .strict();
export type SpendInput = z.infer<typeof spendSchema>;

export const childMoneySchema = z.object({
  /** The money balance. */
  savedCents: z.number().int(),
  /** Saved money not in a jar yet. */
  toSortCents: z.number().int(),
  /** Points since the last payday ("this week so far"). */
  unconvertedPoints: z.number().int(),
  /** What payday would make of them now, each at its own rate. */
  unconvertedCents: z.number().int(),
});
export type ChildMoney = z.infer<typeof childMoneySchema>;

export const jarStatsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paydays'), paydays: z.number().int() }),
  z.object({
    kind: z.literal('quests'),
    quests: z.number().int(),
    milestoneCents: z.number().int(),
  }),
]);

/** A jar as screens show it. */
export const jarSchema = z.object({
  id: idSchema,
  childId: idSchema,
  name: z.string(),
  emoji: z.string(),
  targetCents: z.number().int(),
  inCents: z.number().int(),
  shopUrl: z.string().nullable(),
  /** The shop link's picture, served by the PC, when it has one. */
  imageUrl: z.string().nullable(),
  /** Made on the kiosk by the child. */
  madeByChild: z.boolean(),
  /** A parent has checked (or set) the price. */
  priceChecked: z.boolean(),
  /** Smashed and waiting for a grown-up to buy it. */
  smashed: z.boolean(),
  progress: z.object({
    big: z.boolean(),
    full: z.boolean(),
    fillToCents: z.number().int(),
    fill: z.number(),
    passed: z.array(z.number().int()),
    nextMilestoneCents: z.number().int().nullable(),
    /** Every level it fills towards, ending with the price (the ⭐ lines). */
    milestones: z.array(z.number().int()),
  }),
  stats: jarStatsSchema.nullable(),
});
export type Jar = z.infer<typeof jarSchema>;

/** An envelope waiting to be opened on the kiosk. */
export const envelopeSchema = z.object({
  id: idSchema,
  childId: idSchema,
  cents: z.number().int(),
  note: z.string(),
  fromName: z.string(),
  createdAt: z.number().int(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** Payday as every screen needs it. */
export const paydayInfoSchema = z.object({
  day: z.number().int(),
  time: z.string(),
  auto: z.boolean(),
  /** The next payday the board counts down to. */
  nextAt: z.number().int(),
  /** A slot that has passed and waits for "Start payday now" (press mode), else null. */
  waitingSlot: z.number().int().nullable(),
  /** The latest payday that ran, for the show. */
  latestId: idSchema.nullable(),
  latestRanAt: z.number().int().nullable(),
});
export type PaydayInfo = z.infer<typeof paydayInfoSchema>;

/** `GET /api/money`: the phone's Payday tab and each player's money page. */
export const moneyOverviewSchema = z.object({
  serverNow: z.number().int(),
  timezone: z.string(),
  currency: z.string(),
  centsPerPoint: z.number().int(),
  payday: paydayInfoSchema,
  children: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      avatar: z.string(),
      colour: z.string(),
      money: childMoneySchema,
      jars: z.array(jarSchema),
      envelopes: z.array(envelopeSchema),
    }),
  ),
});
export type MoneyOverview = z.infer<typeof moneyOverviewSchema>;

export const savingsRowSchema = z.object({
  /** The ledger row. */
  id: idSchema,
  kind: z.enum(['payday', 'gift', 'spend', 'bought']),
  at: z.number().int(),
  /** Payday: the slot it covered ("Payday · Sun 27 Sept"). Others: when it happened. */
  dateAt: z.number().int(),
  /** Gift, spend and bought: the note, or the jar's name. */
  note: z.string().nullable(),
  /** Payday only. */
  quests: z.number().int().nullable(),
  points: z.number().int().nullable(),
  cents: z.number().int(),
  /** Saved after this row. */
  balanceCents: z.number().int(),
  /** The parent who sent or spent it. */
  by: z.string().nullable(),
  /** Spent from a jar, or the jar bought. */
  jar: z.object({ emoji: z.string(), name: z.string() }).nullable(),
});
export type SavingsRow = z.infer<typeof savingsRowSchema>;

/** `GET /api/children/:id/savings`: the savings book, newest first. */
export const savingsBookSchema = z.object({
  childId: idSchema,
  money: childMoneySchema,
  /** "⏳ This week so far": quests approved since the last payday, points and their worth. */
  thisWeek: z.object({
    quests: z.number().int(),
    points: z.number().int(),
    cents: z.number().int(),
  }),
  /** "↳ in the 🎮 PlayStation 5 jar". */
  jars: z.array(
    z.object({ id: idSchema, emoji: z.string(), name: z.string(), inCents: z.number().int() }),
  ),
  rows: z.array(savingsRowSchema),
});
export type SavingsBook = z.infer<typeof savingsBookSchema>;

/** A child's streak: decided by the server from `streak_days`, never by a screen. */
export const streakSchema = z.object({
  days: z.number().int(),
  best: z.number().int(),
  /** `flameTier(days)`: the flame's colour. */
  tier: z.number().int(),
});
export type Streak = z.infer<typeof streakSchema>;

/** `GET /api/paydays/latest`: what the show displays. */
export const paydaySummarySchema = z.object({
  id: idSchema,
  /** The slot it covered. */
  at: z.number().int(),
  ranAt: z.number().int(),
  /** The parent who pressed start, or null when it started by itself. */
  startedBy: z.string().nullable(),
  centsPerPoint: z.number().int(),
  currency: z.string(),
  children: z.array(
    z.object({
      childId: idSchema,
      name: z.string(),
      avatar: z.string(),
      colour: z.string(),
      stats: z.object({
        questsDone: z.number().int(),
        earlyBonuses: z.number().int(),
        unprompted: z.number().int(),
        bestDay: z.object({ date: z.string(), points: z.number().int() }).nullable(),
      }),
      /** The streak on payday (spec 005), for the show's 🔥 Streak line. */
      streak: streakSchema,
      /** Converted at this payday (0 when nothing was). */
      points: z.number().int(),
      cents: z.number().int(),
      envelopes: z.array(
        z.object({ id: idSchema, fromName: z.string(), note: z.string(), cents: z.number().int() }),
      ),
    }),
  ),
});
export type PaydaySummary = z.infer<typeof paydaySummarySchema>;

/** What a move answers: the jar and the child's money after it. */
export const goalMoveResultSchema = z.object({
  goalId: idSchema,
  childId: idSchema,
  cents: z.number().int(),
  inCents: z.number().int(),
  toSortCents: z.number().int(),
});
export type GoalMoveResult = z.infer<typeof goalMoveResultSchema>;

// ---------------------------------------------------------------------------
// Kiosk dashboard (spec 001)

/** Any wall-clock "HH:MM" (instances may hold times edited outside the quest editor). */
const wallTimeSchema = z.string().regex(HH_MM, 'Expected a time as HH:MM');
const instantSchema = z.number().int();

export const kioskQuestSchema = z.object({
  /** The chore instance's id. */
  id: idSchema,
  choreId: idSchema,
  title: z.string(),
  icon: z.string(),
  /** The chore is "TOGETHER" (a 👫 Shared tag). */
  shared: z.boolean(),
  status: z.enum(['open', 'claimed', 'approved']),
  /** The instance's snapshot of its chore's times (ADR 0004), for the marker labels. */
  times: z.object({
    bonusBefore: wallTimeSchema,
    dueBy: wallTimeSchema,
    lateAfter: wallTimeSchema,
  }),
  /** The same times resolved to instants for today. */
  window: z.object({ bonusBefore: instantSchema, dueBy: instantSchema, lateAfter: instantSchema }),
  loot: z.object({
    basePoints: z.number().int(),
    earlyBonus: z.number().int(),
    unpromptedBonus: z.number().int(),
    latePenalty: z.number().int(),
  }),
  /** Open only: the stage at `serverNow`. */
  stage: choreStageSchema.nullable(),
  /** Open only: "up to +N" at `serverNow`. */
  maxPoints: z.number().int().nullable(),
  claimedAt: instantSchema.nullable(),
  /** Claimed only: the points worked out at claim time ("+N pending"). */
  pendingPoints: z.number().int().nullable(),
  approvedAt: instantSchema.nullable(),
  /** Approved only: the points awarded. */
  awardedPoints: z.number().int().nullable(),
  /**
   * Open only: a parent sent it back (spec 002). `by` is the parent's name, when known.
   * Cleared when the child claims it again.
   */
  sentBack: z.object({ reason: sendBackReasonSchema, by: z.string().nullable() }).nullable(),
});
export type KioskQuest = z.infer<typeof kioskQuestSchema>;

/**
 * The latest streak change worth a morning report (spec 005, ADR 0012). `id` is its
 * `streak.decided` event, which each kiosk remembers once shown.
 */
export const streakReportSchema = z.object({
  id: idSchema,
  /** The days it covers, oldest first (several after the PC was off). */
  dates: z.array(isoDateSchema),
  result: z.enum(['done', 'missed']),
  before: z.number().int(),
  after: z.number().int(),
  bestBefore: z.number().int(),
  best: z.number().int(),
  /** Missed only: the first quest left open on the newest missed day. */
  missedQuest: z.string().nullable(),
  /** When the server decided it (epoch ms). */
  at: z.number().int(),
});
export type StreakReport = z.infer<typeof streakReportSchema>;

export const kioskChildSchema = z.object({
  id: idSchema,
  name: z.string(),
  avatar: z.string(),
  colour: z.string(),
  xp: z.number().int(),
  level: z.object({
    level: z.number().int(),
    xpIntoLevel: z.number().int(),
    xpForThisLevel: z.number().int(),
    xpToNext: z.number().int(),
  }),
  /** Average chore points (XP) per day over the last 14 days; null with no history. */
  xpPerDay: z.number().nullable(),
  pointsToday: z.number().int(),
  streak: streakSchema.extend({ last: streakReportSchema.nullable() }),
  /** A parent made today a sick day (ADR 0012): every waiting quest is skipped. */
  sickToday: z.boolean(),
  /** Saved, to sort and this week's points (spec 004). */
  money: childMoneySchema,
  /** Live jars in jar order (the board shows the first four). */
  jars: z.array(jarSchema),
  /** Gifts waiting to be opened, oldest first. */
  envelopes: z.array(envelopeSchema),
  /** The open quest the Next-up countdown shows at `serverNow`, or null when none is open. */
  nextUpId: idSchema.nullable(),
  /** In spec order: open (most pressing first), claimed, then approved. */
  quests: z.array(kioskQuestSchema),
});
export type KioskChild = z.infer<typeof kioskChildSchema>;

/** `GET /api/kiosk/today`. */
export const kioskTodaySchema = z.object({
  /** The server's clock (epoch ms) when it answered: the kiosk ticks on from this. */
  serverNow: instantSchema,
  /** Today in the family time zone. */
  date: isoDateSchema,
  timezone: z.string(),
  /** When today started (tracking bars never start before it). */
  dayStart: instantSchema,
  /** The development clock is moved away from real time. */
  devClock: z.boolean(),
  currency: z.string(),
  centsPerPoint: z.number().int(),
  payday: paydayInfoSchema,
  /** In column order (`users.sort_order`). */
  children: z.array(kioskChildSchema),
});
export type KioskToday = z.infer<typeof kioskTodaySchema>;

// ---------------------------------------------------------------------------
// Development clock (only when the server runs with PMP_DEV_CLOCK=1)

/**
 * `PUT /api/dev/clock`: move the server's clock to "HH:MM" today (family time zone) or to
 * "YYYY-MM-DDTHH:MM", after which it keeps ticking. `null` goes back to real time.
 */
export const devClockRequestSchema = z.object({
  at: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2}T)?([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM or YYYY-MM-DDTHH:MM')
    .refine((v) => !v.includes('T') || isIsoDate(v.slice(0, 10)), 'Invalid date')
    .nullable(),
});
export type DevClockRequest = z.infer<typeof devClockRequestSchema>;

export const devClockSchema = z.object({
  /** How far the clock is moved from real time, in ms (0 = real time). */
  offsetMs: z.number().int(),
  now: instantSchema,
});
export type DevClock = z.infer<typeof devClockSchema>;

/** `POST /api/chores` may also say which library tile it came from. */
export const choreLibraryRefSchema = z.object({
  libraryId: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .nullable()
    .default(null),
});

// ---------------------------------------------------------------------------
// The phone's Players tab (spec 003, ADR 0009)

/** One player card: `GET /api/children`. Money comes from the ledger (0 until Phase 4). */
export const playerCardSchema = z.object({
  id: idSchema,
  name: z.string(),
  age: z.number().int().nullable(),
  avatar: z.string(),
  colour: z.string(),
  streak: streakSchema,
  /** Today is a sick day: all their waiting quests are skipped (ADR 0012). */
  sickToday: z.boolean(),
  /** Quests this child is a player on (not deleted). */
  quests: z.number().int(),
  pointsToday: z.number().int(),
  /** Money saved, in cents: the ledger's balance. */
  cents: z.number().int(),
});
export type PlayerCard = z.infer<typeof playerCardSchema>;
export const playerListSchema = z.array(playerCardSchema);

/** `DELETE /api/children/:id`: the quests left with no players (ADR 0009). */
export const removedPlayerSchema = z.object({ questsLeftEmpty: z.array(idSchema) });

/** `GET /api/parents`: the GAME MASTERS rows. */
export const gameMasterListSchema = z.array(
  z.object({ id: idSchema, name: z.string(), phones: z.number().int() }),
);
export type GameMasterList = z.infer<typeof gameMasterListSchema>;

/** What `POST /api/children/:id/adjust` answers, and the `child.adjusted` event carries. */
export const adjustmentSchema = z.object({
  childId: idSchema,
  points: z.number().int(),
  /** The child's points today after it. */
  pointsToday: z.number().int(),
});
export type Adjustment = z.infer<typeof adjustmentSchema>;

// ---------------------------------------------------------------------------
// HTTPS and push (ADR 0002, ADR 0009)

/** `GET /api/access`: the server's HTTPS address, when it has one (set or learned). */
export const accessInfoSchema = z.object({ secureUrl: z.string().nullable() });
export type AccessInfo = z.infer<typeof accessInfoSchema>;

/** `POST /api/devices/invites`: `move` makes a code that also unpairs this phone. */
export const inviteRequestSchema = z.object({ move: z.boolean().default(false) }).strict();

/** `GET /api/push/key`: the VAPID public key for `pushManager.subscribe`. */
export const pushKeySchema = z.object({ publicKey: z.string() });

/** A browser's `PushSubscription.toJSON()`. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2000),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

/**
 * `POST /api/devices/me/push-test`: a test notification to this phone, optionally after a
 * delay so the phone can be locked first (ADR 0002's Doze check).
 */
export const pushTestRequestSchema = z
  .object({ delaySeconds: z.number().int().min(0).max(900).default(0) })
  .strict();
