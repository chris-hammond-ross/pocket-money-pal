import { describe, expect, it } from 'vitest';
import {
  applyPending,
  applyPendingPause,
  decodeReplaced,
  encodeReplaced,
  foldOutbox,
  nextTempId,
  offlineDayPlan,
  oneOffPassed,
  outboxLabel,
  outboxOutcome,
  pendingChoreIds,
  plannedQuests,
  queuedPause,
  type OutboxItem,
  type OutboxOp,
  type OutboxResult,
} from './outbox';
import type { Chore, DayPlan } from './schemas';

const TODAY = '2026-10-05'; // a Monday

const chore = (id: number, fields: Partial<Chore> = {}): Chore => ({
  id,
  title: `Quest ${id}`,
  icon: '⭐',
  libraryId: null,
  together: false,
  bonusBefore: '08:00',
  dueBy: '09:00',
  lateAfter: '10:00',
  basePoints: 10,
  earlyBonus: 0,
  unpromptedBonus: 0,
  latePenalty: 0,
  days: ['mon', 'tue'],
  oneOffDate: null,
  childIds: [1],
  ...fields,
});

const input = (fields: Partial<Chore> = {}): Omit<Chore, 'id'> => {
  const rest: Partial<Chore> = chore(0, fields);
  delete rest.id;
  return rest as Omit<Chore, 'id'>;
};

let keys = 0;
const item = (op: OutboxOp, syncedAt = 1000, name = 'x'): Omit<OutboxItem, 'request'> => ({
  key: `k${++keys}`,
  op,
  name,
  queuedAt: 0,
  syncedAt,
});

const fold = (...ops: Omit<OutboxItem, 'request'>[]) =>
  ops.reduce<OutboxItem[]>((q, i) => foldOutbox(q, i), []);

describe('foldOutbox', () => {
  it('queues a change with its request', () => {
    const [queued] = fold(item({ kind: 'chore.update', choreId: 3, patch: { days: ['mon'] } }));
    expect(queued!.request).toEqual({
      method: 'PATCH',
      url: '/api/chores/3',
      body: '{"days":["mon"]}',
    });
  });

  it('folds an edit into a new quest, keeping its key and place', () => {
    const q = fold(
      item({ kind: 'chore.create', choreId: -1, input: input({ title: 'Fish' }) }),
      item({ kind: 'pause', pause: null }),
      item({ kind: 'chore.update', choreId: -1, patch: { title: 'Feed the fish' } }, 1000, 'new'),
    );
    expect(q).toHaveLength(2);
    expect(q[0]!.key).toBe(`k${keys - 2}`);
    expect(q[0]!.name).toBe('new');
    expect(q[0]!.op).toMatchObject({ kind: 'chore.create', input: { title: 'Feed the fish' } });
    expect(q[0]!.request.method).toBe('POST');
    expect(JSON.parse(q[0]!.request.body!)).toMatchObject({ title: 'Feed the fish' });
  });

  it('drops a new quest deleted before it was sent', () => {
    const q = fold(
      item({ kind: 'chore.create', choreId: -1, input: input() }),
      item({ kind: 'chore.delete', choreId: -1 }),
    );
    expect(q).toEqual([]);
  });

  it('merges edits, keeping the earliest sync time', () => {
    const q = fold(
      item({ kind: 'chore.update', choreId: 3, patch: { title: 'A', basePoints: 5 } }, 500),
      item({ kind: 'chore.update', choreId: 3, patch: { title: 'B' } }, 900),
    );
    expect(q).toHaveLength(1);
    expect(q[0]!.op).toEqual({
      kind: 'chore.update',
      choreId: 3,
      patch: { title: 'B', basePoints: 5 },
    });
    expect(q[0]!.syncedAt).toBe(500);
  });

  it('replaces an edit with a delete', () => {
    const q = fold(
      item({ kind: 'chore.update', choreId: 3, patch: { title: 'A' } }),
      item({ kind: 'chore.delete', choreId: 3 }),
    );
    expect(q.map((i) => i.op.kind)).toEqual(['chore.delete']);
    expect(q[0]!.request).toEqual({ method: 'DELETE', url: '/api/chores/3', body: null });
  });

  it('keeps one holiday item, the latest', () => {
    const q = fold(
      item({ kind: 'pause', pause: { from: '2026-10-09', until: null } }),
      item({ kind: 'pause', pause: null }),
    );
    expect(q).toHaveLength(1);
    expect(q[0]!.request).toEqual({ method: 'DELETE', url: '/api/pause', body: null });
  });

  it('keeps quests apart', () => {
    const q = fold(
      item({ kind: 'chore.update', choreId: 3, patch: { title: 'A' } }),
      item({ kind: 'chore.update', choreId: 4, patch: { title: 'B' } }),
    );
    expect(q).toHaveLength(2);
  });

  it('never folds into a sealed item', () => {
    const sealed = { ...fold(item({ kind: 'chore.create', choreId: -1, input: input() }))[0]! };
    sealed.sealed = true;
    const q = foldOutbox(
      [sealed],
      item({ kind: 'chore.update', choreId: -1, patch: { title: 'B' } }),
    );
    expect(q).toHaveLength(2);
    expect(q[1]!.request.url).toBe('/api/chores/-1');
    const deleted = foldOutbox([sealed], item({ kind: 'chore.delete', choreId: -1 }));
    expect(deleted.map((i) => i.op.kind)).toEqual(['chore.create', 'chore.delete']);
  });
});

describe('nextTempId and pendingChoreIds', () => {
  it('counts down below every queued id', () => {
    expect(nextTempId([])).toBe(-1);
    const q = fold(
      item({ kind: 'chore.create', choreId: -1, input: input() }),
      item({ kind: 'chore.create', choreId: -2, input: input() }),
      item({ kind: 'chore.update', choreId: 7, patch: {} }),
      item({ kind: 'pause', pause: null }),
    );
    expect(nextTempId(q)).toBe(-3);
    expect(pendingChoreIds(q)).toEqual(new Set([-1, -2, 7]));
  });
});

describe('applyPending', () => {
  it('adds, changes and removes quests', () => {
    const q = fold(
      item({ kind: 'chore.create', choreId: -1, input: input({ title: 'New' }) }),
      item({ kind: 'chore.update', choreId: 1, patch: { days: ['sun'] } }),
      item({ kind: 'chore.delete', choreId: 2 }),
    );
    const list = applyPending([chore(1), chore(2)], q);
    expect(list.map((c) => [c.id, c.title, c.days])).toEqual([
      [1, 'Quest 1', ['sun']],
      [-1, 'New', ['mon', 'tue']],
    ]);
  });

  it('applies the latest holiday', () => {
    expect(applyPendingPause({ from: TODAY, until: null }, [])).toEqual({
      from: TODAY,
      until: null,
    });
    const q = fold(item({ kind: 'pause', pause: null }));
    expect(applyPendingPause({ from: TODAY, until: null }, q)).toBeNull();
  });
});

describe('plannedQuests and offlineDayPlan', () => {
  const base: DayPlan = {
    date: TODAY,
    today: TODAY,
    serverNow: 0,
    timezone: 'Europe/London',
    centsPerPoint: 5,
    currency: 'GBP',
    children: [],
    quests: [
      {
        chore: chore(1),
        skipped: false,
        instances: [
          {
            id: 10,
            childId: 1,
            status: 'claimed',
            claimedAt: 1,
            unprompted: false,
            points: 10,
            sentBack: null,
          },
        ],
      },
      { chore: chore(2), skipped: false, instances: [] },
    ],
    paused: false,
  };

  it('lists what runs on a date, by due time', () => {
    const quests = plannedQuests(
      [
        chore(1, { dueBy: '18:00' }),
        chore(2, { days: ['sun'] }),
        chore(3, { dueBy: '07:00', bonusBefore: '06:00' }),
        chore(4, { days: [], oneOffDate: '2026-10-06' }),
      ],
      '2026-10-06',
    );
    expect(quests.map((q) => q.chore.id)).toEqual([3, 4, 1]);
  });

  it('keeps today’s instances and adds offline changes', () => {
    const chores = [
      chore(1, { days: ['sun'], title: 'Renamed' }), // off today, but claimed: stays
      chore(-1, { title: 'New', dueBy: '08:30', bonusBefore: '08:00' }),
    ]; // 2 was deleted
    const plan = offlineDayPlan(base, TODAY, TODAY, chores, null);
    expect(plan.quests.map((q) => [q.chore.id, q.chore.title, q.instances.length])).toEqual([
      [-1, 'New', 0],
      [1, 'Renamed', 1],
    ]);
  });

  it('plans another day from the quests, and a stale "today" afresh', () => {
    const plan = offlineDayPlan(base, '2026-10-06', TODAY, [chore(1)], {
      from: '2026-10-06',
      until: null,
    });
    expect(plan.date).toBe('2026-10-06');
    expect(plan.paused).toBe(true);
    expect(plan.quests[0]!.instances).toEqual([]);
    // Past midnight with the PC off: yesterday's instances don't carry over.
    const next = offlineDayPlan(base, '2026-10-06', '2026-10-06', [chore(1)], null);
    expect(next.today).toBe('2026-10-06');
    expect(next.quests[0]!.instances).toEqual([]);
  });
});

describe('the PC’s replay rules', () => {
  it('oneOffPassed', () => {
    expect(oneOffPassed('2026-10-04', TODAY)).toBe(true);
    expect(oneOffPassed(TODAY, TODAY)).toBe(false);
    expect(oneOffPassed(null, TODAY)).toBe(false);
    expect(oneOffPassed(undefined, TODAY)).toBe(false);
  });

  it.each([
    // [queued, current, result]
    [{ from: '2026-10-07', until: null }, null, { from: '2026-10-07', moved: false }],
    [{ from: TODAY, until: '2026-10-08' }, null, { from: TODAY, moved: false }],
    [{ from: '2026-10-03', until: '2026-10-08' }, null, { from: TODAY, moved: true }],
    [{ from: '2026-10-03', until: null }, null, { from: TODAY, moved: true }],
    // Changing the end of the one going on keeps its start.
    [
      { from: '2026-10-03', until: '2026-10-10' },
      { from: '2026-10-03', until: '2026-10-06' },
      { from: '2026-10-03', moved: false },
    ],
    [{ from: '2026-10-01', until: '2026-10-04' }, null, 'pause-over'],
  ] as const)('queuedPause %j over %j', (next, current, expected) => {
    const result = queuedPause(next, current, TODAY);
    if (expected === 'pause-over') {
      expect(result).toEqual({ error: 'pause-over' });
      return;
    }
    expect(result).toEqual({
      pause: { from: expected.from, until: next.until },
      moved: expected.moved,
    });
  });

  it('round-trips X-PMP-Replaced, names and all', () => {
    const header = encodeReplaced({ by: 'Zoë', at: 123 });
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeReplaced(header)).toEqual({ by: 'Zoë', at: 123 });
    expect(decodeReplaced(null)).toBeNull();
    expect(decodeReplaced('%E0%A4%A')).toBeNull();
    expect(decodeReplaced(encodeURIComponent('{"by":1}'))).toBeNull();
  });
});

describe('outboxLabel and outboxOutcome', () => {
  it('labels each kind', () => {
    expect(outboxLabel({ op: { kind: 'chore.delete', choreId: 1 }, name: '🐟 Fish' })).toBe(
      'Delete: 🐟 Fish',
    );
    expect(outboxLabel({ op: { kind: 'pause', pause: null }, name: 'resume now' })).toBe(
      'Holiday: resume now',
    );
  });

  const result = (fields: Partial<OutboxResult>): OutboxResult => ({
    key: 'k',
    kind: 'chore.update',
    choreId: 1,
    name: 'x',
    pause: null,
    status: 200,
    code: null,
    replaced: null,
    moved: null,
    at: 0,
    announced: false,
    ...fields,
  });

  it.each([
    [{}, 'sent'],
    [{ replaced: encodeReplaced({ by: 'Sam', at: 1 }) }, 'look'],
    [{ kind: 'pause' as const, choreId: null, moved: TODAY }, 'look'],
    [{ status: 404 }, 'failed'],
    [{ status: 409, code: 'date-passed' }, 'failed'],
    [{ kind: 'chore.delete' as const, status: 404 }, 'sent'],
  ])('%j → %s', (fields, outcome) => {
    expect(outboxOutcome(result(fields))).toBe(outcome);
  });
});
