import { zonedTimeToInstant } from '@pmp/shared';
import { describe, expect, it, vi } from 'vitest';
import { devClockTarget, ServerClock } from './clock';

const TZ = 'Europe/London';
const at = (date: string, time: string) => zonedTimeToInstant(date, time, TZ);

describe('ServerClock', () => {
  it('reads real time until moved, then keeps ticking from the new time', () => {
    let real = at('2026-09-30', '10:00');
    const clock = new ServerClock(() => real);
    expect(clock.now()).toBe(real);

    clock.setTo(at('2026-09-30', '18:40'));
    expect(clock.offsetMs).toBe(8 * 3_600_000 + 40 * 60_000);
    real += 90_000;
    expect(clock.now()).toBe(at('2026-09-30', '18:40') + 90_000);

    clock.reset();
    expect(clock.offsetMs).toBe(0);
    expect(clock.now()).toBe(real);
  });

  it('tells listeners when it moves', () => {
    const clock = new ServerClock(() => 0);
    const listener = vi.fn();
    const off = clock.onChange(listener);
    clock.setTo(1000);
    clock.reset();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    clock.setTo(5);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('devClockTarget', () => {
  it("puts HH:MM on today's date in the family time zone", () => {
    // 23:30 UTC on 30 September is already 1 October in London.
    const realNow = Date.UTC(2026, 8, 30, 23, 30);
    expect(devClockTarget('07:05', realNow, TZ)).toBe(at('2026-10-01', '07:05'));
  });

  it('takes a full date and time as given', () => {
    expect(devClockTarget('2026-03-29T01:30', 0, TZ)).toBe(at('2026-03-29', '01:30'));
  });
});
