import { describe, expect, it } from 'vitest';
import {
  claimPushText,
  DEFAULT_QUIET_HOURS,
  isQuietTime,
  paydayReadyPushText,
  smashPushText,
} from './notify';

describe('isQuietTime', () => {
  it('is never quiet with no quiet hours', () => {
    expect(isQuietTime(null, '03:00')).toBe(false);
  });

  it('runs past midnight: from is quiet, until is not', () => {
    const q = DEFAULT_QUIET_HOURS; // 20:00–07:00
    expect(isQuietTime(q, '19:59')).toBe(false);
    expect(isQuietTime(q, '20:00')).toBe(true);
    expect(isQuietTime(q, '23:59')).toBe(true);
    expect(isQuietTime(q, '00:00')).toBe(true);
    expect(isQuietTime(q, '06:59')).toBe(true);
    expect(isQuietTime(q, '07:00')).toBe(false);
    expect(isQuietTime(q, '12:00')).toBe(false);
  });

  it('handles a window within one day', () => {
    const q = { from: '13:00', until: '15:30' };
    expect(isQuietTime(q, '12:59')).toBe(false);
    expect(isQuietTime(q, '13:00')).toBe(true);
    expect(isQuietTime(q, '15:29')).toBe(true);
    expect(isQuietTime(q, '15:30')).toBe(false);
  });

  it('treats equal times as an empty window', () => {
    expect(isQuietTime({ from: '08:00', until: '08:00' }, '08:00')).toBe(false);
  });
});

describe('claimPushText', () => {
  it('names the quest for one claim, and counts the tray', () => {
    expect(claimPushText([{ childName: 'Alice', title: 'Make your bed' }], 3)).toEqual({
      title: 'Alice claimed ‘Make your bed’',
      body: '3 to check · tap to approve',
    });
  });

  it('counts quests for one child with several claims', () => {
    const claims = [
      { childName: 'Alice', title: 'Make your bed' },
      { childName: 'Alice', title: 'Feed the cat' },
    ];
    expect(claimPushText(claims, 2).title).toBe('Alice claimed 2 quests');
  });

  it('names every child, once each', () => {
    const claims = [
      { childName: 'Alice', title: 'Make your bed' },
      { childName: 'Billy', title: 'Make your bed' },
      { childName: 'Alice', title: 'Feed the cat' },
      { childName: 'Cara', title: 'Homework' },
    ];
    expect(claimPushText(claims, 5).title).toBe('Alice, Billy and Cara claimed 4 quests');
  });

  it('names the one quest when each child claimed it (a shared quest, a team surprise)', () => {
    const claims = [
      { childName: 'Alice', title: 'Sweep the patio' },
      { childName: 'Billy', title: 'Sweep the patio' },
    ];
    expect(claimPushText(claims, 2).title).toBe('Alice and Billy claimed ‘Sweep the patio’');
  });
});

describe('money push texts', () => {
  it('says payday is ready', () => {
    expect(paydayReadyPushText()).toEqual({
      title: "💰 It's payday!",
      body: 'Start it when the kids are ready.',
      tag: 'payday',
    });
  });

  it('says which jar was smashed', () => {
    expect(smashPushText('Billy', 'Basketball', '£24.99')).toEqual({
      title: '🔨 Billy smashed the Basketball jar',
      body: '£24.99 ready · needs buying',
      tag: 'smash',
    });
  });
});
