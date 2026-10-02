import { zonedDateOf, zonedTimeToInstant } from '@pmp/shared';

/**
 * The server's clock: real time, plus an offset that only the development clock moves
 * (`PMP_DEV_CLOCK=1`). Every rule and timestamp on the server reads `now()` from here, so
 * with the offset set the whole app behaves as if it were that time, and every screen
 * agrees because they all take their time from the server.
 */
export class ServerClock {
  private offset = 0;
  private readonly listeners = new Set<() => void>();

  /** @param realNow the real clock (faked in tests). */
  constructor(readonly realNow: () => number = Date.now) {}

  readonly now = (): number => this.realNow() + this.offset;

  get offsetMs(): number {
    return this.offset;
  }

  /** Makes the clock read `target` now; it keeps ticking from there. */
  setTo(target: number): void {
    this.setOffset(target - this.realNow());
  }

  reset(): void {
    this.setOffset(0);
  }

  private setOffset(offset: number): void {
    this.offset = offset;
    this.listeners.forEach((listener) => listener());
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * The instant a dev-clock request means: "HH:MM" is that time on today's real date in the
 * family time zone, and "YYYY-MM-DDTHH:MM" is that date and time.
 */
export function devClockTarget(at: string, realNow: number, timeZone: string): number {
  if (at.includes('T')) return zonedTimeToInstant(at.slice(0, 10), at.slice(11), timeZone);
  return zonedTimeToInstant(zonedDateOf(realNow, timeZone), at, timeZone);
}
