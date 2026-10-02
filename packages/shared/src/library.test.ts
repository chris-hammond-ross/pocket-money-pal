import { describe, expect, it } from 'vitest';
import { CHORE_LIBRARY, LIBRARY_SECTIONS } from './library';
import { choreLibraryItemSchema } from './schemas';

describe('CHORE_LIBRARY', () => {
  it('has about 16 chores across every section', () => {
    expect(CHORE_LIBRARY).toHaveLength(16);
    expect(new Set(CHORE_LIBRARY.map((c) => c.section))).toEqual(new Set(LIBRARY_SECTIONS));
  });

  it.each(CHORE_LIBRARY.map((c) => [c.id, c] as const))('%s passes chore validation', (_, c) => {
    expect(choreLibraryItemSchema.safeParse({ ...c, days: [...c.days] }).error).toBeUndefined();
  });

  it('has unique ids and titles', () => {
    expect(new Set(CHORE_LIBRARY.map((c) => c.id)).size).toBe(CHORE_LIBRARY.length);
    expect(new Set(CHORE_LIBRARY.map((c) => c.title)).size).toBe(CHORE_LIBRARY.length);
  });

  it('is rejected by the schema when times are out of order', () => {
    const bad = { ...CHORE_LIBRARY[0]!, days: ['mon'], bonusBefore: '10:00', dueBy: '09:00' };
    expect(choreLibraryItemSchema.safeParse(bad).success).toBe(false);
  });
});
