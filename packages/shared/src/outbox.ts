/**
 * Planning while the family PC is off (spec 007, ADR 0017). The phone queues quest and
 * holiday changes as requests; the PC applies them when the phone can reach it again.
 * Pure functions: the queue folds as it grows, the phone draws its offline view from it,
 * and the PC's replay rules for requests that arrive late live here too.
 */
import { z } from 'zod';
import { choreRunsOn, isPausedOn, type SchedulePause } from './chores';
import type { Chore, ChoreCreate, ChorePatch, DayPlan, DayQuest } from './schemas';

/** Request headers a queued change carries, and the PC's answers. Lower case, as Node has them. */
export const OUTBOX_HEADERS = {
  /** A UUID: the PC answers a repeat with the first answer, never applying it twice. */
  key: 'idempotency-key',
  /** The PC's clock (epoch ms) when the phone last heard from it. */
  queued: 'x-pmp-queued',
  /** Answer: this replaced another parent's newer change (URI-encoded `replacedChange`). */
  replaced: 'x-pmp-replaced',
  /** Answer: a holiday that should already have started now starts on this date. */
  moved: 'x-pmp-moved',
} as const;

/** The Background Sync tag the phone registers, and the service worker answers. */
export const OUTBOX_SYNC_TAG = 'pmp-outbox';

/** How long the PC keeps each key's answer. */
export const REPLAY_KEEP_MS = 30 * 86_400_000;

/** A queued change. A new quest has a temporary negative id until the PC gives it one. */
export type OutboxOp =
  | { kind: 'chore.create'; choreId: number; input: ChoreCreate }
  | { kind: 'chore.update'; choreId: number; patch: ChorePatch }
  | { kind: 'chore.delete'; choreId: number }
  | { kind: 'pause'; pause: SchedulePause | null };

export interface OutboxItem {
  /** Sent as `Idempotency-Key`. */
  key: string;
  op: OutboxOp;
  /** "🐟 Feed the fish", or the holiday in words: for the queue sheet and the results. */
  name: string;
  /** This phone's clock when it was queued. */
  queuedAt: number;
  /** The PC's clock when the phone last heard from it, sent as `X-PMP-Queued`. */
  syncedAt: number;
  /**
   * It may have reached the PC already (sent, then the answer was lost): never folded
   * into, because a repeat of its key gets the first answer, not the folded change.
   */
  sealed?: boolean;
  /** The request, worked out from `op` so the service worker can send it as it is. */
  request: { method: string; url: string; body: string | null };
}

/** What the queue sheet calls an item. */
export function outboxLabel(item: Pick<OutboxItem, 'op' | 'name'>): string {
  switch (item.op.kind) {
    case 'chore.create':
      return `New quest: ${item.name}`;
    case 'chore.update':
      return `Edit: ${item.name}`;
    case 'chore.delete':
      return `Delete: ${item.name}`;
    case 'pause':
      return `Holiday: ${item.name}`;
  }
}

/** Which quest (or the holiday) an op changes: the queue keeps one item each. */
function targetOf(op: OutboxOp): string {
  return op.kind === 'pause' ? 'pause' : `chore:${op.choreId}`;
}

export function outboxRequest(op: OutboxOp): OutboxItem['request'] {
  switch (op.kind) {
    case 'chore.create':
      return { method: 'POST', url: '/api/chores', body: JSON.stringify(op.input) };
    case 'chore.update':
      return { method: 'PATCH', url: `/api/chores/${op.choreId}`, body: JSON.stringify(op.patch) };
    case 'chore.delete':
      return { method: 'DELETE', url: `/api/chores/${op.choreId}`, body: null };
    case 'pause':
      return op.pause === null
        ? { method: 'DELETE', url: '/api/pause', body: null }
        : { method: 'PUT', url: '/api/pause', body: JSON.stringify(op.pause) };
  }
}

/** The new op folded onto the queued one for the same target; null when both cancel out. */
function fold(queued: OutboxOp, next: OutboxOp): OutboxOp | null {
  if (queued.kind === 'pause' || next.kind === 'pause') return next;
  if (queued.kind === 'chore.create') {
    if (next.kind === 'chore.delete') return null;
    if (next.kind === 'chore.update') {
      return { ...queued, input: { ...queued.input, ...next.patch } };
    }
  }
  if (queued.kind === 'chore.update' && next.kind === 'chore.update') {
    return { ...queued, patch: { ...queued.patch, ...next.patch } };
  }
  return next;
}

/**
 * The queue with `item` added. At most one unsealed item per quest and one for the
 * holiday: a create takes later edits into its body, edits merge, a delete after a create
 * drops both, and a later delete or holiday replaces what was there. The folded item keeps
 * its place and its key, and the earliest `syncedAt` (what the phone knew when it started).
 */
export function foldOutbox(
  queue: readonly OutboxItem[],
  item: Omit<OutboxItem, 'request'>,
): OutboxItem[] {
  const target = targetOf(item.op);
  const at = queue.findLastIndex((q) => !q.sealed && targetOf(q.op) === target);
  if (at === -1) return [...queue, { ...item, request: outboxRequest(item.op) }];
  const queued = queue[at]!;
  const op = fold(queued.op, item.op);
  if (op === null) return queue.filter((_, i) => i !== at);
  const merged: OutboxItem = {
    ...queued,
    op,
    name: item.name,
    syncedAt: Math.min(queued.syncedAt, item.syncedAt),
    request: outboxRequest(op),
  };
  return queue.map((q, i) => (i === at ? merged : q));
}

/** The next temporary id for a quest made offline: below every one in the queue. */
export function nextTempId(queue: readonly OutboxItem[]): number {
  const ids = queue.flatMap((q) => (q.op.kind === 'pause' ? [] : [q.op.choreId]));
  return Math.min(0, ...ids) - 1;
}

/** The quests as they will be once the queue is sent: what the tabs show offline. */
export function applyPending(chores: readonly Chore[], queue: readonly OutboxItem[]): Chore[] {
  let list = [...chores];
  for (const { op } of queue) {
    if (op.kind === 'chore.create') {
      const { libraryId, ...input } = op.input;
      list = [...list.filter((c) => c.id !== op.choreId), { ...input, libraryId, id: op.choreId }];
    } else if (op.kind === 'chore.update') {
      list = list.map((c) => (c.id === op.choreId ? { ...c, ...op.patch } : c));
    } else if (op.kind === 'chore.delete') {
      list = list.filter((c) => c.id !== op.choreId);
    }
  }
  return list;
}

/** The holiday as it will be once the queue is sent. */
export function applyPendingPause(
  pause: SchedulePause | null,
  queue: readonly OutboxItem[],
): SchedulePause | null {
  const last = queue.findLast((q) => q.op.kind === 'pause');
  return last?.op.kind === 'pause' ? last.op.pause : pause;
}

/** Quests with a change waiting, for the ⏳ marks. */
export function pendingChoreIds(queue: readonly OutboxItem[]): Set<number> {
  return new Set(queue.flatMap((q) => (q.op.kind === 'pause' ? [] : [q.op.choreId])));
}

function byDueTime(a: DayQuest, b: DayQuest): number {
  return a.chore.dueBy.localeCompare(b.chore.dueBy) || a.chore.title.localeCompare(b.chore.title);
}

/** A day other than today on the Day tab: what the plan schedules, by due time. */
export function plannedQuests(chores: readonly Chore[], date: string): DayQuest[] {
  return chores
    .filter((c) => choreRunsOn(c, date))
    .map((chore) => ({ chore, skipped: false, instances: [] }))
    .sort(byDueTime);
}

/**
 * The Day tab with the PC off: `base` is the last plan the phone has for that date (or
 * for any day, for the children and settings), `chores` and `pause` already have the
 * queue applied, and `today` is from this phone's clock. Today keeps the instances it
 * last saw; a quest made or changed offline has none yet.
 */
export function offlineDayPlan(
  base: DayPlan,
  date: string,
  today: string,
  chores: readonly Chore[],
  pause: SchedulePause | null,
): DayPlan {
  const byId = new Map(chores.map((c) => [c.id, c]));
  let quests: DayQuest[];
  if (date === today && base.date === today && base.today === today) {
    const seen = new Set<number>();
    const kept = base.quests.flatMap((q): DayQuest[] => {
      const chore = byId.get(q.chore.id);
      seen.add(q.chore.id);
      if (!chore) return [];
      const active = q.instances.some((i) => i.status !== 'skipped');
      return choreRunsOn(chore, date) || active ? [{ ...q, chore }] : [];
    });
    const added = plannedQuests(
      chores.filter((c) => !seen.has(c.id)),
      date,
    );
    quests = [...kept, ...added].sort(byDueTime);
  } else {
    quests = plannedQuests(chores, date);
  }
  return { ...base, date, today, quests, paused: isPausedOn(pause, date) };
}

// ---------------------------------------------------------------------------
// The PC's side

/** A queued one-off quest for a day that has passed by the time it arrives. */
export function oneOffPassed(oneOffDate: string | null | undefined, today: string): boolean {
  return oneOffDate !== null && oneOffDate !== undefined && oneOffDate < today;
}

/**
 * A queued holiday arriving late. One that should already have started starts today
 * instead (`moved`); one already over is refused. The PC's own `pauseProblem` still runs
 * after this.
 */
export function queuedPause(
  next: SchedulePause,
  current: SchedulePause | null,
  today: string,
): { pause: SchedulePause; moved: boolean } | { error: 'pause-over' } {
  if (next.until !== null && next.until < today) return { error: 'pause-over' };
  const ongoing = current !== null && current.from === next.from && isPausedOn(current, today);
  if (next.from < today && !ongoing) return { pause: { ...next, from: today }, moved: true };
  return { pause: next, moved: false };
}

/** `X-PMP-Replaced`: another parent's change that this one replaced. */
export const replacedChangeSchema = z.object({ by: z.string(), at: z.number().int() });
export type ReplacedChange = z.infer<typeof replacedChangeSchema>;

export function encodeReplaced(change: ReplacedChange): string {
  return encodeURIComponent(JSON.stringify(change));
}

export function decodeReplaced(header: string | null | undefined): ReplacedChange | null {
  if (!header) return null;
  try {
    const parsed = replacedChangeSchema.safeParse(JSON.parse(decodeURIComponent(header)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What happened to a sent item, as the service worker records it for the page. */
export const outboxResultSchema = z.object({
  key: z.string(),
  kind: z.enum(['chore.create', 'chore.update', 'chore.delete', 'pause']),
  /** The quest (its real id once created), or null for the holiday. */
  choreId: z.number().int().nullable(),
  name: z.string(),
  /** The holiday's dates as queued, for "the holiday from … was over". */
  pause: z.object({ from: z.string(), until: z.string().nullable() }).nullable(),
  status: z.number().int(),
  /** The PC's `error` code, when it gave a string one. */
  code: z.string().nullable(),
  /** `X-PMP-Replaced`, still encoded. */
  replaced: z.string().nullable(),
  /** `X-PMP-Moved`: the holiday's new start. */
  moved: z.string().nullable(),
  at: z.number(),
  /** The page has shown it in a banner (or the worker in a notification). */
  announced: z.boolean(),
});
export type OutboxResult = z.infer<typeof outboxResultSchema>;

/** How a result reads: applied, applied but worth a look, or not applied. */
export function outboxOutcome(result: OutboxResult): 'sent' | 'look' | 'failed' {
  // Deleting a quest that's already gone is what was wanted.
  if (result.kind === 'chore.delete' && result.status === 404) return 'sent';
  if (result.status >= 400) return 'failed';
  return result.replaced !== null || result.moved !== null ? 'look' : 'sent';
}
