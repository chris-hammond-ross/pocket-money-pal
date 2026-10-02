import { describe, expect, it } from 'vitest';
import { CHORE_LIBRARY } from './library';
import { formatMoney } from './money';
import { setupDraftSchema, setupRequestSchema, type SetupDraft } from './schemas';
import {
  AVATAR_CHOICES,
  COLOUR_CHOICES,
  choreFromLibrary,
  formatRate,
  gameMastersProblem,
  nextPlayerLook,
  removePlayerFromDraft,
  toggleQuestForPlayer,
} from './setup';

const bed = CHORE_LIBRARY.find((c) => c.id === 'make-bed')!;
const bins = CHORE_LIBRARY.find((c) => c.id === 'bins')!;

describe('nextPlayerLook', () => {
  it('starts with the first choices', () => {
    expect(nextPlayerLook([])).toEqual({ avatar: AVATAR_CHOICES[0], colour: COLOUR_CHOICES[0] });
  });

  it('skips avatars and colours already taken, whatever the case', () => {
    const look = nextPlayerLook([
      { avatar: AVATAR_CHOICES[0], colour: COLOUR_CHOICES[1].toUpperCase() },
    ]);
    expect(look).toEqual({ avatar: AVATAR_CHOICES[1], colour: COLOUR_CHOICES[0] });
  });

  it('cycles once every choice is taken', () => {
    const everyone = COLOUR_CHOICES.map((colour, i) => ({ avatar: AVATAR_CHOICES[i]!, colour }));
    expect(nextPlayerLook(everyone).colour).toBe(COLOUR_CHOICES[0]);
    expect(nextPlayerLook(everyone).avatar).toBe(AVATAR_CHOICES[COLOUR_CHOICES.length]);
  });
});

describe('toggleQuestForPlayer', () => {
  it('adds a library tile as a new quest for the player', () => {
    const chores = toggleQuestForPlayer([], bed, 'billy');
    expect(chores).toEqual([choreFromLibrary(bed, ['billy'])]);
    expect(chores[0]).toMatchObject({ key: 'lib:make-bed', libraryId: 'make-bed', days: bed.days });
  });

  it('gives an existing quest to a second player', () => {
    const one = toggleQuestForPlayer([], bed, 'billy');
    const two = toggleQuestForPlayer(one, bed, 'alice');
    expect(two).toHaveLength(1);
    expect(two[0]!.childKeys).toEqual(['billy', 'alice']);
  });

  it('takes it away again, and drops a quest nobody has', () => {
    let chores = toggleQuestForPlayer([], bed, 'billy');
    chores = toggleQuestForPlayer(chores, bins, 'billy');
    chores = toggleQuestForPlayer(chores, bed, 'billy');
    expect(chores.map((c) => c.key)).toEqual(['lib:bins']);
  });

  it('switches TOGETHER off when fewer than two players are left', () => {
    let chores = toggleQuestForPlayer(toggleQuestForPlayer([], bed, 'a'), bed, 'b');
    chores = chores.map((c) => ({ ...c, together: true }));
    chores = toggleQuestForPlayer(chores, bed, 'b');
    expect(chores[0]).toMatchObject({ childKeys: ['a'], together: false });
  });

  it('toggles your own quests by key, and ignores unknown keys', () => {
    const own = { ...choreFromLibrary(bed, ['a']), key: 'own:1', libraryId: null };
    expect(toggleQuestForPlayer([own], 'own:1', 'b')[0]!.childKeys).toEqual(['a', 'b']);
    expect(toggleQuestForPlayer([own], 'own:9', 'b')).toEqual([own]);
  });
});

describe('removePlayerFromDraft', () => {
  it('takes the player off every quest and drops quests left empty', () => {
    const draft: SetupDraft = {
      stage: 'quests',
      parentNames: ['Mum'],
      children: [
        { key: 'a', name: 'Alice', age: 9, avatar: '🦄', colour: '#e64980' },
        { key: 'b', name: 'Billy', age: 7, avatar: '🦖', colour: '#228be6' },
      ],
      chores: [
        { ...choreFromLibrary(bed, ['a', 'b']), together: true },
        choreFromLibrary(bins, ['b']),
      ],
      centsPerPoint: 5,
    };
    const after = removePlayerFromDraft(draft, 'b');
    expect(after.children.map((c) => c.key)).toEqual(['a']);
    expect(after.chores).toHaveLength(1);
    expect(after.chores[0]).toMatchObject({ childKeys: ['a'], together: false });
    expect(setupDraftSchema.safeParse(after).success).toBe(true);
  });
});

describe('gameMastersProblem', () => {
  it.each([
    [[], 'incomplete'],
    [[{ name: ' ' }], 'incomplete'],
    [[{ name: 'Mum' }], null],
    [[{ name: 'Mum' }, { name: ' mum ' }], 'duplicate-name'],
    [[{ name: 'Mum' }, { name: 'Dad' }], null],
  ])('%j → %s', (parents, expected) => {
    expect(gameMastersProblem(parents)).toBe(expected);
  });
});

describe('formatRate', () => {
  it('uses pence and cents for small amounts', () => {
    expect(formatRate(5, 'GBP')).toBe('5p');
    expect(formatRate(12, 'USD')).toBe('12¢');
  });

  it('falls back to a full amount', () => {
    expect(formatRate(150, 'GBP', 'en-GB')).toBe('£1.50');
    expect(formatRate(5, 'SEK', 'en-GB')).toBe(formatMoney(5, 'SEK', 'en-GB'));
  });
});

describe('setup drafts and requests', () => {
  it('library quests pass the setup request schema', () => {
    const chores = CHORE_LIBRARY.map((item) => choreFromLibrary(item, ['a']));
    const parsed = setupRequestSchema.safeParse({
      parents: [{ name: 'Mum' }],
      children: [{ key: 'a', name: 'Alice', age: 9, avatar: '🦄', colour: '#e64980' }],
      chores,
      centsPerPoint: 5,
      timezone: 'America/New_York',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an unknown time zone', () => {
    const parsed = setupRequestSchema.safeParse({
      parents: [{ name: 'Mum' }],
      children: [{ key: 'a', name: 'Alice', age: 9, avatar: '🦄', colour: '#e64980' }],
      chores: [choreFromLibrary(bed, ['a'])],
      centsPerPoint: 5,
      timezone: 'Mars/Olympus',
    });
    expect(parsed.success).toBe(false);
  });

  it('an empty draft is valid', () => {
    const draft = { stage: 'title', parentNames: [], children: [], chores: [], centsPerPoint: 5 };
    expect(setupDraftSchema.safeParse(draft).success).toBe(true);
  });
});
