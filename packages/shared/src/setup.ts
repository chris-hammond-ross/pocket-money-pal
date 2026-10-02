/**
 * First-run setup rules (spec 003) that the page and the server share: new players' looks,
 * handing out library quests, and checking the grown-ups before moving on.
 */
import type { ChoreLibraryItem } from './library';
import type { SetupChore, SetupDraft } from './schemas';

/** Avatars offered in the player editor's carousel. */
export const AVATAR_CHOICES = [
  '🦖', '🦄', '🐯', '🐼', '🦊', '🐸', '🐙', '🦁',
  '🐧', '🐉', '🦋', '🤖', '👾', '🚀', '⚽', '🎨',
] as const; // prettier-ignore

/** Player colours (the editor's swatches). */
export const COLOUR_CHOICES = [
  '#228be6', '#e64980', '#40c057', '#fab005', '#7950f2', '#fd7e14', '#15aabf', '#fa5252',
] as const; // prettier-ignore

export const DEFAULT_CENTS_PER_POINT = 5;
export const DEFAULT_CHILD_AGE = 8;

interface Look {
  avatar: string;
  colour: string;
}

/**
 * The look for a new player: the first avatar and colour nobody has yet. Once every choice
 * is taken, it cycles by the number of players so neighbours still differ.
 */
export function nextPlayerLook(players: readonly Look[]): Look {
  const pick = <T extends string>(choices: readonly T[], taken: Set<string>): T =>
    choices.find((c) => !taken.has(c)) ?? choices[players.length % choices.length]!;
  return {
    avatar: pick(AVATAR_CHOICES, new Set(players.map((p) => p.avatar))),
    colour: pick(COLOUR_CHOICES, new Set(players.map((p) => p.colour.toLowerCase()))),
  };
}

/** A setup quest with a library suggestion's times, loot and days. */
export function choreFromLibrary(item: ChoreLibraryItem, childKeys: string[]): SetupChore {
  return {
    key: `lib:${item.id}`,
    libraryId: item.id,
    title: item.title,
    icon: item.icon,
    together: false,
    bonusBefore: item.bonusBefore,
    dueBy: item.dueBy,
    lateAfter: item.lateAfter,
    basePoints: item.basePoints,
    earlyBonus: item.earlyBonus,
    unpromptedBonus: item.unpromptedBonus,
    latePenalty: item.latePenalty,
    days: [...item.days],
    oneOffDate: null,
    childKeys,
  };
}

/** Removes a child from a quest. "TOGETHER" needs two players, so it switches off below that. */
function withoutChild(chore: SetupChore, childKey: string): SetupChore {
  const childKeys = chore.childKeys.filter((k) => k !== childKey);
  return { ...chore, childKeys, together: chore.together && childKeys.length >= 2 };
}

/**
 * "Tap a tile to give it to the selected player, and tap again to take it away." A library
 * tile the family doesn't have yet becomes a new quest; a quest left with no players is
 * dropped. `tile` is a library item or the key of an existing quest.
 */
export function toggleQuestForPlayer(
  chores: readonly SetupChore[],
  tile: ChoreLibraryItem | string,
  childKey: string,
): SetupChore[] {
  const key = typeof tile === 'string' ? tile : `lib:${tile.id}`;
  const existing = chores.find((c) => c.key === key);
  if (!existing) {
    return typeof tile === 'string' ? [...chores] : [...chores, choreFromLibrary(tile, [childKey])];
  }
  if (!existing.childKeys.includes(childKey)) {
    return chores.map((c) =>
      c === existing ? { ...c, childKeys: [...c.childKeys, childKey] } : c,
    );
  }
  const updated = withoutChild(existing, childKey);
  return updated.childKeys.length === 0
    ? chores.filter((c) => c !== existing)
    : chores.map((c) => (c === existing ? updated : c));
}

/** Takes a player out of the draft, and off every quest (dropping quests left empty). */
export function removePlayerFromDraft(draft: SetupDraft, childKey: string): SetupDraft {
  return {
    ...draft,
    children: draft.children.filter((c) => c.key !== childKey),
    chores: draft.chores
      .map((c) => withoutChild(c, childKey))
      .filter((c) => c.childKeys.length > 0),
  };
}

export type GameMastersProblem = 'incomplete' | 'duplicate-name' | null;

/**
 * Why the Game masters stage can't move on yet: a row without a name, or two grown-ups
 * with the same name ("Each grown-up needs a different name."). No PINs (ADR 0008).
 */
export function gameMastersProblem(parents: readonly { name: string }[]): GameMastersProblem {
  const names = parents.map((p) => p.name.trim().toLocaleLowerCase());
  if (names.length === 0 || names.some((n) => !n)) return 'incomplete';
  return new Set(names).size === names.length ? null : 'duplicate-name';
}

/** "5p", "12¢", or a full amount for a rate of a unit or more ("£1.50"). */
export function formatRate(cents: number, currency: string, locale?: string): string {
  if (cents < 100) {
    if (currency === 'GBP') return `${cents}p`;
    if (['USD', 'EUR', 'CAD', 'AUD', 'NZD'].includes(currency)) return `${cents}¢`;
  }
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}
