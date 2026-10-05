import { describe, expect, it } from 'vitest';
import { displayLabel, pickDisplay } from './displays';

const main = { id: 10, label: 'Laptop', size: { width: 2560, height: 1440 } };
const second = { id: 20, label: 'DELL U2419H', size: { width: 1920, height: 1080 } };
const third = { id: 30, label: '', size: { width: 1920, height: 1080 } };

describe('pickDisplay', () => {
  it('uses the first screen that is not the main one', () => {
    expect(pickDisplay([main, second, third], main)).toBe(second);
  });

  it('uses the main screen when it is the only one', () => {
    expect(pickDisplay([main], main)).toBe(main);
  });

  it('uses the screen picked in the tray', () => {
    expect(pickDisplay([main, second, third], main, { savedId: 30 })).toBe(third);
    expect(pickDisplay([main, second], main, { savedId: 10 })).toBe(main);
  });

  it('falls back when the picked screen is unplugged', () => {
    expect(pickDisplay([main, second], main, { savedId: 30 })).toBe(second);
  });

  it('lets PMP_DISPLAY win over the tray', () => {
    expect(pickDisplay([main, second, third], main, { envIndex: '0', savedId: 30 })).toBe(main);
  });

  it('ignores a PMP_DISPLAY index with no screen', () => {
    expect(pickDisplay([main, second], main, { envIndex: '5', savedId: 10 })).toBe(main);
  });
});

describe('displayLabel', () => {
  it('names the screen, its size and whether it is the main one', () => {
    expect(displayLabel(main, 0, true)).toBe('Screen 1: Laptop (2560×1440, main)');
    expect(displayLabel(third, 2, false)).toBe('Screen 3 (1920×1080)');
  });
});
