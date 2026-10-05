import { isPausedOn, PAYDAY_SHOW_FRESH_MS, type Envelope, type PaydaySummary } from '@pmp/shared';
import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, type KioskBoard as Board } from '../../lib/api';
import { clockTime, clockTimeAt } from '../../lib/format';
import { useLiveEvents } from '../../lib/live-events';
import { useServerNow } from '../../lib/server-clock';
import { sound } from '../../lib/sounds';
import { BANNER_MS, KioskCelebrations } from './Celebrations';
import { ClaimSheet } from './ClaimSheet';
import { HolidayScreen, HolidaySoonPill } from './HolidayScreen';
import { EnvelopeCard } from './money/EnvelopeCard';
import { NewJarScreen } from './money/NewJarScreen';
import { PaydayShow } from './money/PaydayShow';
import { SavingsScreen } from './money/SavingsScreen';
import { PairPhoneCard } from './PairPhoneCard';
import classes from './kiosk.module.css';
import { PlayerColumn } from './PlayerColumn';
import { SurpriseOverlay } from './SurpriseOverlay';
import { ringingIds, useBonusAlerts, useKioskSound, useMorningReports } from './use-game-layer';

/** A full-screen money view over the board (spec 004). */
type MoneyView =
  | { kind: 'savings'; childId: number }
  | { kind: 'new-jar'; childId: number; back: 'board' | 'savings' }
  | { kind: 'envelope'; childId: number; envelope: Envelope };

/**
 * The Quest Track board (spec 001): a header with the clock, and one column per child,
 * each ending in its loot card (spec 004). The savings screen, new jar, envelopes and the
 * payday show open over it. In quiet hours it's a silent night sky (spec 005). On a
 * holiday-paused day the holiday screen takes the columns' place (ADR 0016).
 */
export function KioskBoard({ board }: { board: Board }) {
  const now = useServerNow(board.clockOffsetMs);
  const { status, subscribe } = useLiveEvents();
  const [claiming, setClaiming] = useState<number | null>(null);
  const [view, setView] = useState<MoneyView | null>(null);
  const closeSheet = useCallback(() => setClaiming(null), []);
  const closeView = useCallback(() => setView(null), []);
  const show = usePaydayShow(board);
  const surpriseShown = useSurpriseAfterGrab(subscribe);
  const { quiet, until } = useKioskSound(now, board.timezone);
  const ringing = ringingIds(board, now);
  useBonusAlerts(board, now, ringing);
  const reports = useMorningReports(board.children, quiet);
  const viewChild = view && board.children.find((c) => c.id === view.childId);
  const holiday = board.pause && isPausedOn(board.pause, board.date) ? board.pause : null;
  const moneyCtx = {
    currency: board.currency,
    timezone: board.timezone,
    payday: board.payday,
    now,
  };

  const date = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: board.timezone,
  }).format(now);

  // Looked up in the latest board, so the pop-up closes if the quest stops being open
  // (claimed on another kiosk, skipped by a parent, or a new day).
  const claim = board.children
    .flatMap((child) => child.quests.map((quest) => ({ child, quest })))
    .find(({ quest }) => quest.id === claiming && quest.status === 'open');

  return (
    <div className={classes.screen} data-quiet={quiet || undefined}>
      <header className={classes.header}>
        <h1 className={classes.title}>★ POCKET MONEY PAL ★</h1>
        <div className={classes.headerRight}>
          {quiet && (
            <span className={classes.quietPill}>
              <span className={classes.moon}>🌙</span> Quiet hours
              {until && ` · sounds back at ${clockTime(until)}`}
            </span>
          )}
          {board.pause && !holiday && <HolidaySoonPill pause={board.pause} today={board.date} />}
          {status === 'closed' && <span className={classes.offlinePill}>Reconnecting…</span>}
          {board.devClock && (
            <button
              type="button"
              className={classes.devPill}
              title="The server's clock is moved. Click to go back to real time."
              onClick={() => void api.setDevClock(null)}
            >
              DEV CLOCK ✕
            </button>
          )}
          <div className={classes.day}>
            <div className={classes.clock}>{clockTimeAt(now, board.timezone)}</div>
            <div>{date}</div>
          </div>
        </div>
      </header>
      {holiday ? (
        <HolidayScreen
          pause={holiday}
          today={board.date}
          players={board.children}
          onSavings={(childId) => setView({ kind: 'savings', childId })}
        />
      ) : (
        <main
          className={classes.board}
          style={{ '--cols': Math.max(1, board.children.length) } as CSSProperties}
        >
          {board.children.map((child) => (
            <PlayerColumn
              key={child.id}
              child={child}
              now={now}
              dayStart={board.dayStart}
              timezone={board.timezone}
              payday={board.payday}
              currency={board.currency}
              ringing={ringing}
              report={reports.playing[child.id]}
              onReportClose={() => {
                const report = reports.playing[child.id];
                if (report) reports.close(report.id);
              }}
              onClaim={(quest) => setClaiming(quest.id)}
              onSavings={() => {
                sound.tap();
                setView({ kind: 'savings', childId: child.id });
              }}
              onNewJar={() => {
                sound.tap();
                setView({ kind: 'new-jar', childId: child.id, back: 'board' });
              }}
              onEnvelope={(envelope) => setView({ kind: 'envelope', childId: child.id, envelope })}
            />
          ))}
        </main>
      )}
      <AnimatePresence>
        {claim && (
          <ClaimSheet
            key={claim.quest.id}
            quest={claim.quest}
            child={claim.child}
            now={now}
            onClose={closeSheet}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {view?.kind === 'savings' && viewChild && (
          <SavingsScreen
            key={`savings-${viewChild.id}`}
            child={viewChild}
            ctx={moneyCtx}
            onClose={closeView}
            onNewJar={() => setView({ kind: 'new-jar', childId: viewChild.id, back: 'savings' })}
          />
        )}
        {view?.kind === 'new-jar' && viewChild && (
          <NewJarScreen
            key={`new-jar-${viewChild.id}`}
            child={viewChild}
            currency={board.currency}
            onClose={() =>
              setView(view.back === 'savings' ? { kind: 'savings', childId: viewChild.id } : null)
            }
          />
        )}
        {view?.kind === 'envelope' && viewChild && (
          <EnvelopeCard
            key={`envelope-${view.envelope.id}`}
            envelope={view.envelope}
            child={viewChild}
            currency={board.currency}
            onClose={closeView}
            onToJars={() => setView({ kind: 'savings', childId: viewChild.id })}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {show.summary && (
          <PaydayShow
            key={`payday-${show.summary.id}`}
            summary={show.summary}
            players={board.children}
            currency={board.currency}
            onClose={show.close}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {/* Closes by itself when its countdown runs out here; the server expires it too. */}
        {board.surprise && (board.surprise.run.expiresAt ?? 0) > now && surpriseShown && (
          <SurpriseOverlay
            key={`surprise-${board.surprise.run.id}`}
            surprise={board.surprise}
            players={board.children}
            now={now}
          />
        )}
      </AnimatePresence>
      <PairPhoneCard />
      <KioskCelebrations />
    </div>
  );
}

/**
 * After a grab, the next surprise waits on this screen until the grab's banner and
 * confetti have played (spec 006): otherwise its overlay would cover them at once.
 */
function useSurpriseAfterGrab(subscribe: ReturnType<typeof useLiveEvents>['subscribe']) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((event) => {
      if (event.type !== 'surprise.grabbed') return;
      setHeld(true);
      clearTimeout(timer);
      timer = setTimeout(() => setHeld(false), BANNER_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [subscribe]);
  return !held;
}

/** The last payday this kiosk showed (spec 004): display state, so it lives here. */
const SHOWN_KEY = 'pmp.paydayShown';

function readShown(): number | null {
  try {
    const value = localStorage.getItem(SHOWN_KEY);
    return value === null ? null : Number(value);
  } catch {
    return null;
  }
}

function writeShown(id: number): void {
  try {
    localStorage.setItem(SHOWN_KEY, String(id));
  } catch {
    // Private mode or storage off: the show may play again on reload, which is harmless.
  }
}

/**
 * Plays each payday's show once on this kiosk: when the server's latest payday is newer
 * than the last one shown here. A kiosk that has never shown one only plays a recent one.
 */
function usePaydayShow(board: Board) {
  const { latestId, latestRanAt } = board.payday;
  const [summary, setSummary] = useState<PaydaySummary | null>(null);

  useEffect(() => {
    if (latestId === null || latestRanAt === null) return;
    const shown = readShown();
    if (shown !== null && shown >= latestId) return;
    writeShown(latestId);
    if (shown === null && Date.now() - latestRanAt > PAYDAY_SHOW_FRESH_MS) return;
    api.latestPayday().then(
      (latest) => {
        if (latest?.id === latestId) setSummary(latest);
      },
      () => undefined,
    );
  }, [latestId, latestRanAt]);

  return { summary, close: useCallback(() => setSummary(null), []) };
}
