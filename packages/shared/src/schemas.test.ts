import { describe, expect, it } from 'vitest';
import {
  adjustRequestSchema,
  approveRequestSchema,
  chorePatchSchema,
  pairCheckRequestSchema,
  pairRequestSchema,
  childInputSchema,
  choreInputSchema,
  claimRequestSchema,
  familySettingsPatchSchema,
  schedulePauseSchema,
  sendBackRequestSchema,
  setupRequestSchema,
  childPatchSchema,
  inviteRequestSchema,
  phoneSettingsPatchSchema,
  pushSubscriptionSchema,
  quietHoursSchema,
  envelopeCreateSchema,
  goalCreateSchema,
  goalMoveSchema,
  goalPatchSchema,
  spendSchema,
} from './schemas';
import { serverEventSchema } from './events';

const chore = {
  title: 'Tidy shared bedroom',
  icon: '🧸',
  childIds: [1, 2],
  together: true,
  bonusBefore: '17:00',
  dueBy: '18:30',
  lateAfter: '19:30',
  basePoints: 10,
  earlyBonus: 5,
  unpromptedBonus: 5,
  latePenalty: 3,
  days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
};

const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((i) => i.message) ?? [];

describe('choreInputSchema', () => {
  it('accepts a valid chore and defaults oneOffDate', () => {
    const parsed = choreInputSchema.parse(chore);
    expect(parsed.oneOffDate).toBeNull();
    expect(choreInputSchema.parse({ ...chore, title: '  Feed the cat  ' }).title).toBe(
      'Feed the cat',
    );
  });

  it('keeps deadlines in order, allowing equal times', () => {
    expect(choreInputSchema.safeParse({ ...chore, bonusBefore: '18:45' }).success).toBe(false);
    expect(choreInputSchema.safeParse({ ...chore, lateAfter: '18:15' }).success).toBe(false);
    expect(
      choreInputSchema.safeParse({
        ...chore,
        bonusBefore: '18:30',
        dueBy: '18:30',
        lateAfter: '18:30',
      }).success,
    ).toBe(true);
  });

  it('only allows 15-minute steps', () => {
    expect(messages(choreInputSchema.safeParse({ ...chore, dueBy: '18:20' }))).toContain(
      'Times go in 15-minute steps',
    );
    for (const bad of ['6:30', '25:00', '18:99', 'soon']) {
      expect(choreInputSchema.safeParse({ ...chore, dueBy: bad }).success).toBe(false);
    }
  });

  it('needs days or a one-off date, not both', () => {
    expect(messages(choreInputSchema.safeParse({ ...chore, days: [] }))).toContain(
      'Pick at least one day',
    );
    expect(
      choreInputSchema.safeParse({ ...chore, days: [], oneOffDate: '2026-10-01' }).success,
    ).toBe(true);
    expect(choreInputSchema.safeParse({ ...chore, oneOffDate: '2026-10-01' }).success).toBe(false);
    expect(
      choreInputSchema.safeParse({ ...chore, days: [], oneOffDate: '2026-02-30' }).success,
    ).toBe(false);
    expect(choreInputSchema.safeParse({ ...chore, days: ['mon', 'mon'] }).success).toBe(false);
  });

  it('checks players', () => {
    expect(choreInputSchema.safeParse({ ...chore, childIds: [] }).success).toBe(false);
    expect(choreInputSchema.safeParse({ ...chore, childIds: [1, 1] }).success).toBe(false);
    expect(choreInputSchema.safeParse({ ...chore, childIds: [1] }).success).toBe(false);
    expect(choreInputSchema.safeParse({ ...chore, childIds: [1], together: false }).success).toBe(
      true,
    );
  });

  it('checks title and points', () => {
    expect(choreInputSchema.safeParse({ ...chore, title: '   ' }).success).toBe(false);
    expect(choreInputSchema.safeParse({ ...chore, title: 'x'.repeat(41) }).success).toBe(false);
    expect(choreInputSchema.safeParse({ ...chore, basePoints: -1 }).success).toBe(false);
    expect(choreInputSchema.safeParse({ ...chore, earlyBonus: 2.5 }).success).toBe(false);
  });
});

describe('people', () => {
  it('validates children', () => {
    const billy = { name: 'Billy', age: 10, avatar: '🦖', colour: '#228be6' };
    expect(childInputSchema.safeParse(billy).success).toBe(true);
    expect(childInputSchema.safeParse({ ...billy, age: 2 }).success).toBe(false);
    expect(childInputSchema.safeParse({ ...billy, age: 18 }).success).toBe(false);
    expect(childInputSchema.safeParse({ ...billy, name: 'Maximilianusss' }).success).toBe(true);
    expect(childInputSchema.safeParse({ ...billy, name: 'Maximilianussss' }).success).toBe(false);
    expect(childInputSchema.safeParse({ ...billy, colour: 'blue' }).success).toBe(false);
  });
});

describe('setupRequestSchema', () => {
  const setup = {
    parents: [{ name: 'Mum' }, { name: 'Dad' }],
    children: [
      { key: 'c1', name: 'Billy', age: 10, avatar: '🦖', colour: '#228be6' },
      { key: 'c2', name: 'Alice', age: 8, avatar: '🦄', colour: '#e64980' },
    ],
    chores: [{ ...chore, childIds: undefined, childKeys: ['c1', 'c2'] }],
    centsPerPoint: 5,
  };

  it('accepts a full setup', () => {
    expect(setupRequestSchema.safeParse(setup).success).toBe(true);
  });

  it('refuses two grown-ups with the same name, ignoring case', () => {
    const dupe = { ...setup, parents: [setup.parents[0], { name: 'mum' }] };
    expect(messages(setupRequestSchema.safeParse(dupe))).toContain(
      'Each grown-up needs a different name.',
    );
  });

  it('refuses two players with the same name, ignoring case', () => {
    const dupe = {
      ...setup,
      children: [setup.children[0], { ...setup.children[1], name: 'billy' }],
    };
    expect(setupRequestSchema.safeParse(dupe).success).toBe(false);
  });

  it('refuses quests for unknown players', () => {
    const bad = { ...setup, chores: [{ ...setup.chores[0], childKeys: ['c1', 'c9'] }] };
    expect(messages(setupRequestSchema.safeParse(bad))).toContain('Unknown player');
  });

  it('needs at least one of everything, and a rate of at least 1p', () => {
    expect(setupRequestSchema.safeParse({ ...setup, parents: [] }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...setup, children: [] }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...setup, chores: [] }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...setup, centsPerPoint: 0 }).success).toBe(false);
  });
});

describe('request bodies', () => {
  it('validates batch approval', () => {
    const item = { id: 1, early: true, unprompted: false, late: false };
    expect(approveRequestSchema.parse({ items: [item] }).items[0]!.extra).toBe(0);
    expect(approveRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(approveRequestSchema.safeParse({ items: [item, item] }).success).toBe(false);
  });

  it('lets batch approval leave chips out, so the server uses the claim defaults', () => {
    const parsed = approveRequestSchema.parse({ items: [{ id: 3 }] });
    expect(parsed.items[0]).toEqual({ id: 3, extra: 0 });
  });

  it('validates send-back reasons', () => {
    expect(sendBackRequestSchema.safeParse({ reason: 'needs_redo' }).success).toBe(true);
    expect(sendBackRequestSchema.safeParse({ reason: 'because' }).success).toBe(false);
  });

  it('validates bonus points', () => {
    expect(adjustRequestSchema.safeParse({ points: 10 }).success).toBe(true);
    expect(adjustRequestSchema.safeParse({ points: -5, note: 'Cheek' }).success).toBe(true);
    expect(adjustRequestSchema.safeParse({ points: 0 }).success).toBe(false);
  });

  it('validates claims: the child tapped in, and whether they were asked', () => {
    expect(claimRequestSchema.safeParse({ childId: 2, unprompted: true }).success).toBe(true);
    expect(claimRequestSchema.safeParse({ unprompted: true }).success).toBe(false);
    expect(claimRequestSchema.safeParse({ childId: 0, unprompted: true }).success).toBe(false);
    expect(claimRequestSchema.safeParse({ childId: 2, unprompted: 'yes' }).success).toBe(false);
  });

  it('validates settings changes', () => {
    expect(familySettingsPatchSchema.safeParse({ volume: 0 }).success).toBe(true);
    expect(familySettingsPatchSchema.safeParse({ volume: 100 }).success).toBe(true);
    expect(familySettingsPatchSchema.safeParse({ volume: 101 }).success).toBe(false);
    expect(familySettingsPatchSchema.safeParse({ volume: 50.5 }).success).toBe(false);
    expect(familySettingsPatchSchema.safeParse({ centsPerPoint: 10 }).success).toBe(true);
    expect(familySettingsPatchSchema.safeParse({ timezone: 'Mars/Base' }).success).toBe(false);
    expect(familySettingsPatchSchema.safeParse({ currency: 'gbp' }).success).toBe(false);
  });
});

describe('schedulePauseSchema', () => {
  it('accepts a range, a single day and an open-ended pause', () => {
    expect(schedulePauseSchema.safeParse({ from: '2026-10-20', until: '2026-10-27' }).success).toBe(
      true,
    );
    expect(schedulePauseSchema.safeParse({ from: '2026-10-20', until: '2026-10-20' }).success).toBe(
      true,
    );
    expect(schedulePauseSchema.safeParse({ from: '2026-10-20', until: null }).success).toBe(true);
  });

  it('refuses a pause that ends before it starts, or bad dates', () => {
    expect(schedulePauseSchema.safeParse({ from: '2026-10-20', until: '2026-10-19' }).success).toBe(
      false,
    );
    expect(schedulePauseSchema.safeParse({ from: '2026-02-30', until: null }).success).toBe(false);
  });

  it('is part of the settings patch, where null resumes', () => {
    expect(familySettingsPatchSchema.parse({ pause: null })).toEqual({ pause: null });
  });
});

describe('pairing and chore patches', () => {
  it('reads pairing codes as typed, and refuses junk', () => {
    expect(pairCheckRequestSchema.parse({ code: 'k7qm-4pxd' }).code).toBe('K7QM4PXD');
    expect(pairRequestSchema.safeParse({ code: 'K7QM-4PX0', parentId: 1 }).success).toBe(false);
    expect(pairRequestSchema.safeParse({ code: 'K7QM4PXD', parentId: 0 }).success).toBe(false);
  });

  it('a chore patch keeps left-out fields absent (no defaults sneak in)', () => {
    expect(chorePatchSchema.parse({ days: ['mon'] })).toEqual({ days: ['mon'] });
    expect(chorePatchSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(chorePatchSchema.safeParse({ bonusBefore: '08:10' }).success).toBe(false);
  });
});

describe('server events', () => {
  it('parses the phone-era events', () => {
    for (const type of ['chore.created', 'chore.updated', 'chore.deleted'] as const) {
      expect(serverEventSchema.safeParse({ type, choreId: 3 }).success).toBe(true);
    }
    expect(serverEventSchema.safeParse({ type: 'devices.changed' }).success).toBe(true);
    expect(
      serverEventSchema.safeParse({ type: 'instance.sent_back', instanceId: 1, childId: 2 })
        .success,
    ).toBe(true);
  });
});

describe('Players tab and push', () => {
  it('a child patch takes any editor field, and nothing else', () => {
    expect(childPatchSchema.parse({ name: ' Billy ' })).toEqual({ name: 'Billy' });
    expect(childPatchSchema.safeParse({ age: 18 }).success).toBe(false);
    expect(childPatchSchema.safeParse({ archived: true }).success).toBe(false);
  });

  it('phone settings take the rate and quiet hours only', () => {
    expect(phoneSettingsPatchSchema.parse({ centsPerPoint: 7 })).toEqual({ centsPerPoint: 7 });
    expect(phoneSettingsPatchSchema.parse({ quietHours: null })).toEqual({ quietHours: null });
    expect(phoneSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(phoneSettingsPatchSchema.safeParse({ centsPerPoint: 0 }).success).toBe(false);
    expect(phoneSettingsPatchSchema.safeParse({ timezone: 'Europe/Paris' }).success).toBe(false);
  });

  it('quiet hours are on 15-minute steps and not empty', () => {
    expect(quietHoursSchema.safeParse({ from: '21:30', until: '06:45' }).success).toBe(true);
    expect(quietHoursSchema.safeParse({ from: '21:10', until: '06:45' }).success).toBe(false);
    expect(quietHoursSchema.safeParse({ from: '07:00', until: '07:00' }).success).toBe(false);
  });

  it('an invite is a normal one unless it says move', () => {
    expect(inviteRequestSchema.parse({})).toEqual({ move: false });
    expect(inviteRequestSchema.parse({ move: true })).toEqual({ move: true });
  });

  it('a push subscription needs an https endpoint and both keys', () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      expirationTime: null,
      keys: { p256dh: 'BKey', auth: 'auth' },
    };
    expect(pushSubscriptionSchema.safeParse(sub).success).toBe(true);
    expect(
      pushSubscriptionSchema.safeParse({ ...sub, endpoint: 'http://evil.example/x' }).success,
    ).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...sub, keys: { auth: 'a' } }).success).toBe(false);
  });

  it('parses the player events', () => {
    for (const type of ['child.created', 'child.updated', 'child.removed'] as const) {
      expect(serverEventSchema.safeParse({ type, childId: 3 }).success).toBe(true);
    }
    expect(
      serverEventSchema.safeParse({
        type: 'child.adjusted',
        adjustment: { childId: 3, points: -5, pointsToday: 10 },
      }).success,
    ).toBe(true);
  });
});

describe('money and jar schemas (spec 004)', () => {
  const jar = { childId: 1, name: 'Skateboard', emoji: '🛹', targetCents: 5000 };

  it('accepts a jar from the kiosk list, £1 to £1,000, named in 28 characters', () => {
    expect(goalCreateSchema.safeParse(jar).success).toBe(true);
    expect(goalCreateSchema.safeParse({ ...jar, targetCents: 100 }).success).toBe(true);
    expect(goalCreateSchema.safeParse({ ...jar, targetCents: 100_000 }).success).toBe(true);
    expect(goalCreateSchema.safeParse({ ...jar, name: 'x'.repeat(28) }).success).toBe(true);
    expect(
      goalCreateSchema.safeParse({ ...jar, shopUrl: 'https://shop.example/board' }).success,
    ).toBe(true);
  });

  it.each([
    ['an emoji off the list', { emoji: '🍕' }],
    ['a price under £1', { targetCents: 99 }],
    ['a price over £1,000', { targetCents: 100_001 }],
    ['fractions of a penny', { targetCents: 4999.5 }],
    ['a 29-character name', { name: 'x'.repeat(29) }],
    ['a link that is not a web address', { shopUrl: 'file:///etc/passwd' }],
    ['an unknown field', { inCents: 10 }],
  ])('refuses %s', (_label, fields) => {
    expect(goalCreateSchema.safeParse({ ...jar, ...fields }).success).toBe(false);
  });

  it('lets a phone change any jar field, and clear the link', () => {
    expect(goalPatchSchema.safeParse({}).success).toBe(true);
    expect(goalPatchSchema.safeParse({ shopUrl: null, targetCents: 2499 }).success).toBe(true);
    expect(goalPatchSchema.safeParse({ childId: 2 }).success).toBe(false);
  });

  it('moves whole cents, never zero', () => {
    expect(goalMoveSchema.safeParse({ cents: 10 }).success).toBe(true);
    expect(goalMoveSchema.safeParse({ cents: -250 }).success).toBe(true);
    expect(goalMoveSchema.safeParse({ cents: 0 }).success).toBe(false);
    expect(goalMoveSchema.safeParse({ cents: 0.5 }).success).toBe(false);
  });

  it('takes gifts and spending in whole cents above zero, with a 1–40 character note', () => {
    expect(envelopeCreateSchema.safeParse({ cents: 2000, note: '👵 From Grandma' }).success).toBe(
      true,
    );
    expect(envelopeCreateSchema.safeParse({ cents: 0, note: 'x' }).success).toBe(false);
    expect(envelopeCreateSchema.safeParse({ cents: 100, note: ' ' }).success).toBe(false);
    expect(envelopeCreateSchema.safeParse({ cents: 100, note: 'x'.repeat(41) }).success).toBe(
      false,
    );
    expect(spendSchema.safeParse({ cents: 300, note: '🍬 Sweets', goalId: 4 }).success).toBe(true);
    expect(spendSchema.safeParse({ cents: 300, note: '🍬 Sweets', goalId: null }).success).toBe(
      true,
    );
    expect(spendSchema.safeParse({ cents: -300, note: '🍬 Sweets' }).success).toBe(false);
  });

  it('takes payday on the hour, any day of the week', () => {
    expect(phoneSettingsPatchSchema.safeParse({ paydayDay: 0, paydayTime: '18:00' }).success).toBe(
      true,
    );
    expect(phoneSettingsPatchSchema.safeParse({ paydayAuto: false }).success).toBe(true);
    expect(phoneSettingsPatchSchema.safeParse({ paydayDay: 7 }).success).toBe(false);
    expect(phoneSettingsPatchSchema.safeParse({ paydayTime: '18:15' }).success).toBe(false);
  });

  it('parses the money events', () => {
    const events = [
      { type: 'payday.done', paydayId: 3 },
      { type: 'payday.waiting', slot: 1_790_000_000_000 },
      { type: 'goal.created', goalId: 1, childId: 2, byChild: true },
      { type: 'goal.smashed', goalId: 1, childId: 2, byChild: true },
      {
        type: 'goal.moved',
        move: { goalId: 1, childId: 2, cents: 50, inCents: 550, toSortCents: 75 },
      },
      { type: 'envelope.opened', envelopeId: 1, childId: 2 },
      { type: 'money.spent', childId: 2, cents: 300 },
    ];
    for (const event of events) expect(serverEventSchema.safeParse(event).success).toBe(true);
  });
});
