import { describe, expect, it } from 'vitest';
import {
  currentPause,
  daysBetween,
  PAUSE_MAX_DAYS,
  pauseCountdown,
  pauseProblem,
  pauseState,
  pauseUntilFor,
} from './pause';

const TODAY = '2026-10-05';
const pause = (from: string, until: string | null) => ({ from, until });

describe('daysBetween', () => {
  it.each([
    ['2026-10-05', '2026-10-05', 0],
    ['2026-10-05', '2026-10-06', 1],
    ['2026-10-30', '2026-11-02', 3],
    ['2026-03-28', '2026-03-30', 2], // across the spring-forward weekend
    ['2026-10-06', '2026-10-05', -1],
  ])('%s → %s is %i', (a, b, days) => {
    expect(daysBetween(a, b)).toBe(days);
  });
});

describe('currentPause and pauseState', () => {
  it.each([
    [null, null],
    [pause('2026-10-01', '2026-10-04'), null], // over yesterday
    [pause('2026-10-01', TODAY), 'active'], // its last day
    [pause(TODAY, TODAY), 'active'],
    [pause('2026-09-01', null), 'active'],
    [pause('2026-10-06', '2026-10-10'), 'upcoming'],
    [pause('2026-10-06', null), 'upcoming'],
  ])('%j → %s', (p, state) => {
    expect(pauseState(p, TODAY)).toBe(state);
    expect(currentPause(p, TODAY)).toBe(state === null ? null : p);
  });
});

describe('pauseUntilFor', () => {
  it('counts the first day as one of them', () => {
    expect(pauseUntilFor(TODAY, 1)).toBe(TODAY);
    expect(pauseUntilFor(TODAY, 7)).toBe('2026-10-11');
    expect(pauseUntilFor('2026-10-30', 3)).toBe('2026-11-01');
  });
});

describe('pauseProblem', () => {
  it('allows a new pause from today or later, with or without an end', () => {
    expect(pauseProblem(pause(TODAY, '2026-10-11'), null, TODAY)).toBeNull();
    expect(pauseProblem(pause('2026-10-06', null), null, TODAY)).toBeNull();
    expect(pauseProblem(pause(TODAY, TODAY), null, TODAY)).toBeNull();
  });

  it('refuses a new pause that starts in the past', () => {
    expect(pauseProblem(pause('2026-10-04', '2026-10-11'), null, TODAY)).toMatch(/past/);
    // An old pause that's over doesn't count as going on.
    const over = pause('2026-10-01', '2026-10-03');
    expect(pauseProblem(pause('2026-10-01', '2026-10-11'), over, TODAY)).toMatch(/past/);
  });

  it('lets the pause going on keep its start, to change its end or end it today', () => {
    const going = pause('2026-10-01', '2026-10-10');
    expect(pauseProblem(pause('2026-10-01', '2026-10-20'), going, TODAY)).toBeNull();
    expect(pauseProblem(pause('2026-10-01', TODAY), going, TODAY)).toBeNull();
    expect(pauseProblem(pause('2026-10-01', null), going, TODAY)).toBeNull();
    expect(pauseProblem(pause('2026-10-02', '2026-10-20'), going, TODAY)).toMatch(/past/);
  });

  it('refuses an end before today', () => {
    const going = pause('2026-10-01', '2026-10-10');
    expect(pauseProblem(pause('2026-10-01', '2026-10-04'), going, TODAY)).toMatch(/before today/);
  });

  it(`allows up to ${PAUSE_MAX_DAYS} days with an end date`, () => {
    expect(
      pauseProblem(pause(TODAY, pauseUntilFor(TODAY, PAUSE_MAX_DAYS)), null, TODAY),
    ).toBeNull();
    expect(
      pauseProblem(pause(TODAY, pauseUntilFor(TODAY, PAUSE_MAX_DAYS + 1)), null, TODAY),
    ).toMatch(/up to/);
  });
});

describe('pauseCountdown', () => {
  it('counts sleeps to the first day back', () => {
    expect(pauseCountdown(pause('2026-10-01', '2026-10-09'), TODAY)).toEqual({
      backOn: '2026-10-10',
      sleeps: 5,
    });
    expect(pauseCountdown(pause('2026-10-01', TODAY), TODAY)).toEqual({
      backOn: '2026-10-06',
      sleeps: 1,
    });
  });

  it('has no countdown until a parent resumes', () => {
    expect(pauseCountdown(pause('2026-10-01', null), TODAY)).toEqual({
      backOn: null,
      sleeps: null,
    });
  });
});
