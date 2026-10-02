import { describe, expect, it } from 'vitest';
import { claimFeedback, claimProblem, sendBackNote, type ClaimableInstance } from './claims';

describe('claimProblem', () => {
  const open: ClaimableInstance = { childId: 1, status: 'open', date: '2026-09-30' };
  const claim = { childId: 1, today: '2026-09-30' };

  it('allows a child to claim their own open quest today', () => {
    expect(claimProblem(open, claim)).toBeNull();
  });

  it.each([
    ['another child', open, { ...claim, childId: 2 }, 'wrong-child'],
    ['a claimed quest', { ...open, status: 'claimed' }, claim, 'not-open'],
    ['an approved quest', { ...open, status: 'approved' }, claim, 'not-open'],
    ['a skipped quest', { ...open, status: 'skipped' }, claim, 'not-open'],
    ["yesterday's quest", { ...open, date: '2026-09-29' }, claim, 'not-today'],
  ] as const)('refuses %s', (_, instance, request, problem) => {
    expect(claimProblem(instance, request)).toBe(problem);
  });

  it('reports the wrong child before the status, so a column never learns about another', () => {
    expect(claimProblem({ ...open, status: 'claimed' }, { ...claim, childId: 2 })).toBe(
      'wrong-child',
    );
  });
});

describe('claimFeedback', () => {
  it('plays a fanfare with confetti in bonus time', () => {
    expect(claimFeedback('bonus')).toEqual({ sound: 'fanfare', confetti: true });
  });

  it.each(['due', 'overdue', 'late'] as const)('pops without confetti when %s', (stage) => {
    expect(claimFeedback(stage)).toEqual({ sound: 'pop', confetti: false });
  });
});

describe('sendBackNote', () => {
  it("names the parent who sent it back, in spec 002's words", () => {
    expect(sendBackNote('needs_redo', 'Mum')).toBe('↩️ Mum says: Needs a redo');
  });

  it('still reads well when the parent is unknown', () => {
    expect(sendBackNote('not_finished', null)).toBe('↩️ Sent back: Not finished yet');
  });
});
