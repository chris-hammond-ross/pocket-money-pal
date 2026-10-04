import { z } from 'zod';
import {
  adjustmentSchema,
  approvalSchema,
  claimResultSchema,
  goalMoveResultSchema,
  streakReportSchema,
  surpriseRunSchema,
} from './schemas';

/**
 * Events the server pushes to every connected client over the WebSocket.
 * Clients generally react by invalidating the matching query cache.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  /** Sent to each new connection. `build` and `apiVersion` drive client updates (ADR 0011). */
  z.object({
    type: z.literal('hello'),
    serverTime: z.string(),
    clients: z.number().int(),
    build: z.string().nullable(),
    apiVersion: z.number().int(),
  }),
  z.object({ type: z.literal('presence'), clients: z.number().int() }),
  z.object({ type: z.literal('ping'), from: z.string(), at: z.string() }),
  z.object({ type: z.literal('settings.updated') }),
  /** First-run setup finished: the kiosk leaves its title screen. */
  z.object({ type: z.literal('setup.completed') }),
  /** Today's chores changed as a whole (the daily scheduler, skip, put back, one-off). */
  z.object({ type: z.literal('day.changed'), date: z.string() }),
  /** Something wrote to the database from outside the server (e.g. a SQLite editor). */
  z.object({ type: z.literal('data.changed') }),
  /** The development clock moved (PMP_DEV_CLOCK only): every client re-syncs. */
  z.object({ type: z.literal('clock.changed') }),
  /** A child claimed a quest. Every kiosk plays the claim animation (spec 001). */
  z.object({ type: z.literal('instance.claimed'), claim: claimResultSchema }),
  /** A parent approved a chore (or marked it done). Kiosks celebrate, 500ms apart (spec 002). */
  z.object({ type: z.literal('instance.approved'), approval: approvalSchema }),
  /** A parent sent a chore back: it's open again with their note. The kiosk plays a sad tone. */
  z.object({
    type: z.literal('instance.sent_back'),
    instanceId: z.number().int(),
    childId: z.number().int(),
  }),
  /** A parent undid an approval: the points came back off and it waits in the tray again. */
  z.object({
    type: z.literal('instance.undone'),
    instanceId: z.number().int(),
    childId: z.number().int(),
  }),
  /** A chore was created, edited or deleted on a phone. */
  z.object({
    type: z.enum(['chore.created', 'chore.updated', 'chore.deleted']),
    choreId: z.number().int(),
  }),
  /** A player was added, edited or removed on a phone (spec 003, Players tab). */
  z.object({
    type: z.enum(['child.created', 'child.updated', 'child.removed']),
    childId: z.number().int(),
  }),
  /**
   * A child's streak changed (spec 005): a day was decided at midnight, or a pending day
   * resolved, or an undo moved it. `last` is the report to play, as in the kiosk board.
   */
  z.object({
    type: z.literal('streak.updated'),
    childId: z.number().int(),
    last: streakReportSchema.nullable(),
  }),
  /** Bonus (or minus) points from a phone. Kiosks play a coin and "+10 ⭐" (ADR 0009). */
  z.object({ type: z.literal('child.adjusted'), adjustment: adjustmentSchema }),
  /** A device was paired or revoked. A revoked phone finds out by re-checking itself. */
  z.object({ type: z.literal('devices.changed') }),
  /** A payday ran (spec 004): every kiosk plays the show. */
  z.object({ type: z.literal('payday.done'), paydayId: z.number().int() }),
  /** A payday slot passed in "When I press start" mode: phones highlight the button. */
  z.object({ type: z.literal('payday.waiting'), slot: z.number().int() }),
  /**
   * A jar was made, edited (price checked, put back), deleted, smashed or bought.
   * `byChild` says it happened on the kiosk, so phones can show a banner.
   */
  z.object({
    type: z.enum(['goal.created', 'goal.updated', 'goal.deleted', 'goal.smashed', 'goal.bought']),
    goalId: z.number().int(),
    childId: z.number().int(),
    byChild: z.boolean(),
  }),
  /** Coins moved between "to sort" and a jar. The kiosk that moved them already animated it. */
  z.object({ type: z.literal('goal.moved'), move: goalMoveResultSchema }),
  /** A gift was sent from a phone (an envelope waits on the kiosk), or opened. */
  z.object({
    type: z.enum(['envelope.created', 'envelope.opened']),
    envelopeId: z.number().int(),
    childId: z.number().int(),
  }),
  /** Money out from a phone. */
  z.object({ type: z.literal('money.spent'), childId: z.number().int(), cents: z.number().int() }),
  /**
   * A surprise run moved (spec 006): scheduled, waiting behind another (queued), up on the
   * kiosk (live), expired untaken, taken back by a parent, or a scheduled one changed.
   */
  z.object({
    type: z.enum([
      'surprise.scheduled',
      'surprise.queued',
      'surprise.live',
      'surprise.expired',
      'surprise.cancelled',
      'surprise.updated',
    ]),
    run: surpriseRunSchema,
  }),
  /** A child (or, together, every child) grabbed it: kiosks play the fanfare, phones a banner. */
  z.object({
    type: z.literal('surprise.grabbed'),
    run: surpriseRunSchema,
    childIds: z.array(z.number().int()),
    team: z.boolean(),
  }),
  /** A saved surprise quest was made, edited or deleted on a phone. */
  z.object({
    type: z.enum(['surprise_task.created', 'surprise_task.updated', 'surprise_task.deleted']),
    taskId: z.number().int(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];
