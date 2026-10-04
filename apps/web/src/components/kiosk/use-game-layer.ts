import {
  choreStage,
  isBonusEnding,
  isQuietTime,
  zonedTimeOf,
  type KioskChild,
  type StreakReport,
} from '@pmp/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type KioskBoard } from '../../lib/api';
import { preloadSounds, setMuted, setVolume, tickTock } from '../../lib/sounds';
import { playLocalMoment } from './Celebrations';

/**
 * The kiosk's game layer (spec 005) that follows the clock rather than server events:
 * quiet hours, the bonus-ending tick-tock, a bonus running out, and when each morning
 * report plays. Display only: every result shown here was decided by the server.
 */

export interface KioskQuiet {
  quiet: boolean;
  /** When sounds come back ("HH:MM"), while quiet. */
  until: string | null;
}

/**
 * Loads the sounds, follows the family's volume, and mutes every sound in quiet hours
 * (spec 005). Settings refetch on `settings.updated`, so a change on a phone applies at once.
 */
export function useKioskSound(now: number, timezone: string): KioskQuiet {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const volume = settings.data?.volume;
  const hours = settings.data?.quietHours ?? null;
  const quiet = isQuietTime(hours, zonedTimeOf(now, timezone));
  useEffect(preloadSounds, []);
  useEffect(() => {
    if (volume !== undefined) setVolume(volume);
  }, [volume]);
  useEffect(() => setMuted(quiet), [quiet]);
  return { quiet, until: quiet ? (hours?.until ?? null) : null };
}

/** Open quests in their bonus's last 5 minutes, which ring (spec 005, "Bonus ending"). */
export function ringingIds(board: KioskBoard, now: number): Set<number> {
  return new Set(
    board.children.flatMap((c) =>
      c.quests
        .filter((q) => q.status === 'open' && !q.surprise && isBonusEnding(q.window, now))
        .map((q) => q.id),
    ),
  );
}

/** A bonus that ran out this long ago still plays its "−N bonus" (a tick may be late). */
const BONUS_GONE_GRACE_MS = 3_000;

/**
 * One tick-tock a second while any quest on the board rings, however many there are; and
 * the "bloop" when an open quest's bonus runs out unclaimed.
 */
export function useBonusAlerts(board: KioskBoard, now: number, ringing: Set<number>): void {
  const second = Math.floor(now / 1000);
  const anyRinging = ringing.size > 0;
  useEffect(() => {
    if (anyRinging) tickTock(second);
  }, [anyRinging, second]);

  const stages = useRef(new Map<number, string>());
  useEffect(() => {
    const seen = new Map<number, string>();
    for (const quest of board.children.flatMap((c) => c.quests)) {
      if (quest.status !== 'open') continue;
      const stage = choreStage(quest.window, now);
      seen.set(quest.id, stage);
      const justEnded =
        stages.current.get(quest.id) === 'bonus' &&
        stage !== 'bonus' &&
        now - quest.window.bonusBefore < BONUS_GONE_GRACE_MS;
      if (justEnded && quest.loot.earlyBonus > 0) {
        playLocalMoment({
          type: 'bonus.gone',
          instanceId: quest.id,
          points: quest.loot.earlyBonus,
        });
      }
    }
    stages.current = seen;
  }, [board, now]);
}

/** Each child's last morning report shown on this kiosk (display state, so it lives here). */
const SHOWN_KEY = 'pmp.streakShown';

function readShown(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SHOWN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeShown(childId: number, id: number): void {
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify({ ...readShown(), [childId]: id }));
  } catch {
    // Storage off: the report may play again on reload, which is harmless.
  }
}

/**
 * Which morning report each column is playing (spec 005, "When the report plays"). A
 * child's latest report plays once on this kiosk; one that arrives in quiet hours waits
 * for them to end. Nothing older than the latest ever plays.
 */
export function useMorningReports(children: readonly KioskChild[], quiet: boolean) {
  // What this kiosk had shown when it loaded; reports closed since then.
  const [shownAtLoad] = useState(readShown);
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set());

  const playing: Record<number, StreakReport> = {};
  if (!quiet) {
    for (const child of children) {
      const last = child.streak.last;
      if (last && last.id > (shownAtLoad[child.id] ?? 0) && !closed.has(last.id)) {
        playing[child.id] = last;
      }
    }
  }

  // Remember a report as soon as it starts, so a reload doesn't play it again.
  const ids = Object.entries(playing).map(([childId, r]) => `${childId}:${r.id}`);
  const key = ids.join(',');
  useEffect(() => {
    for (const id of key ? key.split(',') : []) {
      const [childId, reportId] = id.split(':').map(Number);
      writeShown(childId!, reportId!);
    }
  }, [key]);

  const close = useCallback((reportId: number) => {
    setClosed((c) => new Set([...c, reportId]));
  }, []);
  return { playing, close };
}
