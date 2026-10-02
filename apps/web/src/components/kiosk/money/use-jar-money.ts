import {
  formatMoney,
  formatPaydayCountdown,
  jarProgress,
  milestonesCrossed,
  moveLimits,
  pourIntervalMs,
  pourStepCents,
  POUR_HOLD_DELAY_MS,
  type Jar,
  type KioskChild,
  type MoveLimits,
  type PaydayInfo,
} from '@pmp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { api } from '../../../lib/api';
import { useLatest } from '../../../lib/use-latest';
import { moneySound, sound } from '../../../lib/sounds';
import { flyTokens } from './fly';

/** A jar as the kiosk draws it right now, including coins not yet confirmed by the server. */
export type ShownJar = Jar & { limits: MoveLimits };

/** How long a move the server hasn't reflected yet is trusted before the server wins. */
const EXPECT_MS = 5_000;

interface Expected {
  jars: Record<number, number>;
  toSort: number;
}

/**
 * A child's "to sort" and jars as the kiosk shows them while coins move (spec 004). The
 * server is the truth: a hold only previews its coins, and a sent move is shown as
 * expected until the board's next fetch agrees (or a few seconds pass). Nothing is decided
 * here: the server checks every move.
 */
export function useJarMoney(child: KioskChild) {
  const queryClient = useQueryClient();
  const [hold, setHold] = useState<{ goalId: number; cents: number } | null>(null);
  const [expected, setExpected] = useState<Expected | null>(null);

  const serverToSort = child.money.toSortCents;
  const serverIn = new Map(child.jars.map((j) => [j.id, j.inCents]));

  // The fetch caught up with what we sent: back to the server. (Adjusting state while
  // rendering, so a later change on the server never brings the old guess back.)
  const caughtUp =
    expected !== null &&
    expected.toSort === serverToSort &&
    Object.entries(expected.jars).every(([id, cents]) => serverIn.get(Number(id)) === cents);
  if (caughtUp) setExpected(null);
  // Or it's been too long: the server wins.
  useEffect(() => {
    if (!expected) return;
    const timer = setTimeout(() => setExpected(null), EXPECT_MS);
    return () => clearTimeout(timer);
  }, [expected]);

  const live = expected && !caughtUp ? expected : null;
  const toSortCents = (live?.toSort ?? serverToSort) - (hold?.cents ?? 0);
  const jars: ShownJar[] = child.jars.map((jar) => {
    const inCents =
      (live?.jars[jar.id] ?? jar.inCents) + (hold?.goalId === jar.id ? hold.cents : 0);
    return {
      ...jar,
      inCents,
      progress: { ...jar.progress, ...jarProgress(inCents, jar.targetCents) },
      limits: moveLimits({
        toSortCents: toSortCents + (hold?.goalId === jar.id ? hold.cents : 0),
        inCents: inCents - (hold?.goalId === jar.id ? hold.cents : 0),
        targetCents: jar.targetCents,
        smashed: jar.smashed,
      }),
    };
  });

  // The latest values for callbacks that run later (timers, the server's answer).
  const latest = useLatest({ jars, toSortCents });

  /** Sends one move. Resolves true when the server took it. */
  const commit = useCallback(
    async (goalId: number, cents: number): Promise<boolean> => {
      const now = latest.current;
      const jar = now.jars.find((j) => j.id === goalId);
      const holding = hold?.goalId === goalId ? hold.cents : 0;
      if (!jar || cents === 0) return false;
      setExpected((prev) => ({
        jars: { ...prev?.jars, [goalId]: jar.inCents - holding + cents },
        toSort: now.toSortCents + holding - cents,
      }));
      setHold(null);
      try {
        await api.moveGoal(goalId, cents);
        void queryClient.invalidateQueries({ queryKey: ['savings', child.id] });
        return true;
      } catch {
        sound.sad();
        setExpected(null);
        void queryClient.invalidateQueries({ queryKey: ['kiosk-today'] });
        return false;
      }
    },
    [child.id, hold, queryClient, latest],
  );

  return { toSortCents, jars, hold, setHold, commit };
}

export type JarMoney = ReturnType<typeof useJarMoney>;

/** "3d 1h" to the next payday, or null while one waits for a grown-up to press start. */
export function paydayCountdown(payday: PaydayInfo, now: number): string | null {
  if (payday.waitingSlot !== null) return null;
  return formatPaydayCountdown(payday.nextAt - now);
}

export interface PourCallbacks {
  /** A quick tap (released before the hold started pouring). */
  onTap?: () => void;
  /** Holding with nothing to sort. */
  onEmpty?: () => void;
  /** A milestone below the price was passed. */
  onMilestone?: (cents: number) => void;
  /** The jar filled up. */
  onFull?: () => void;
  /** Where the coins fly from ("To sort") and to (the jar). */
  from: () => DOMRect | null;
  to: () => DOMRect | null;
}

/**
 * Hold a jar to pour (spec 004): after 250ms, coins fly one at a time from "to sort" into
 * the jar, faster the longer it's held (10p, 25p, 50p, £1). It stops when the child lets go,
 * the jar is full or "to sort" is empty, then sends **one** move. A quick tap stays a tap.
 */
export function usePourHold(money: JarMoney, jar: ShownJar, cb: PourCallbacks) {
  const state = useRef<{
    start: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    pouring: boolean;
    poured: number;
    max: number;
    coins: number;
  } | null>(null);
  const callbacks = useLatest(cb);
  const moneyRef = useLatest(money);
  const jarRef = useLatest(jar);

  const stop = useCallback(() => {
    const s = state.current;
    state.current = null;
    if (!s) return;
    clearTimeout(s.timer);
    if (!s.pouring) callbacks.current.onTap?.();
    else if (s.poured > 0) void moneyRef.current.commit(jarRef.current.id, s.poured);
  }, [callbacks, jarRef, moneyRef]);

  useEffect(
    () => () => {
      if (state.current) clearTimeout(state.current.timer);
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const s = {
        start: Date.now(),
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
        pouring: false,
        poured: 0,
        max: 0,
        coins: 0,
      };
      state.current = s;

      // One coin, then the next a little sooner, until let go, full or out of coins.
      const pourCoin = () => {
        if (state.current !== s) return;
        const held = Date.now() - s.start - POUR_HOLD_DELAY_MS;
        const step = Math.min(pourStepCents(held), s.max - s.poured);
        if (step <= 0) return; // full, or nothing left: wait for the release
        const j = jarRef.current;
        const before = j.inCents - (moneyRef.current.hold?.cents ?? 0) + s.poured;
        s.poured += step;
        const after = before + step;
        moneyRef.current.setHold({ goalId: j.id, cents: s.poured });
        const from = callbacks.current.from();
        const to = callbacks.current.to();
        if (from && to) void flyTokens(from, to, { durationMs: 420, size: 26 });
        moneySound.clink(s.coins++);
        for (const m of milestonesCrossed(before, after, j.targetCents)) {
          callbacks.current.onMilestone?.(m);
        }
        if (after >= j.targetCents) {
          callbacks.current.onFull?.();
          return;
        }
        s.timer = setTimeout(pourCoin, pourIntervalMs(held));
      };

      s.timer = setTimeout(() => {
        if (state.current !== s) return;
        s.pouring = true;
        s.max = jarRef.current.limits.maxIn;
        if (s.max <= 0) {
          if (moneyRef.current.toSortCents <= 0) callbacks.current.onEmpty?.();
          return;
        }
        pourCoin();
      }, POUR_HOLD_DELAY_MS);
    },
    [callbacks, jarRef, moneyRef],
  );

  return { onPointerDown, onPointerUp: stop, onPointerCancel: stop };
}

/** "£12.00" in the family currency. */
export function money(cents: number, currency: string): string {
  return formatMoney(cents, currency);
}
