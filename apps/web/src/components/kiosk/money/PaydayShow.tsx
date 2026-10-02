import {
  formatMoneyShort,
  rateCaption,
  shortDayName,
  type KioskChild,
  type PaydaySummary,
} from '@pmp/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { celebrate } from '../../../lib/confetti';
import { moneySound, sound } from '../../../lib/sounds';
import { arcade } from '../../../theme';
import { Jar } from './Jar';
import classes from './money.module.css';
import { useIdleClose, useMoneyFeedback } from './SavingsScreen';
import { money, usePourHold, useJarMoney, type JarMoney, type ShownJar } from './use-jar-money';

type Phase = 'title' | 'stats' | 'convert' | 'envelopes' | 'pour' | 'finale';

const TITLE_MS = 1_900;
const STAT_GAP_MS = 450;
const STAT_LINES = 4;
const CONVERT_MS = 2_000;
const ENVELOPE_MS = 1_200;
const FINALE_MS = 2_800;
/** The show closes by itself after this long without a touch (spec 004). */
const IDLE_CLOSE_MS = 3 * 60_000;

/**
 * The payday show (spec 004), on every kiosk at once: the title and drum roll, the week's
 * stats, points counting into money, envelopes, then each child pours their pay into jars.
 * The server already converted the money; the show only displays it.
 */
export function PaydayShow({
  summary,
  players,
  currency,
  onClose,
}: {
  summary: PaydaySummary;
  players: KioskChild[];
  currency: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('title');
  const [lines, setLines] = useState(0);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<Set<number>>(new Set());
  useIdleClose(onClose, IDLE_CLOSE_MS);

  const columns = summary.children
    .map((s) => ({ s, child: players.find((c) => c.id === s.childId) }))
    .filter((c): c is { s: (typeof summary.children)[number]; child: KioskChild } => !!c.child);
  const hasEnvelopes = columns.some((c) => c.s.envelopes.length > 0);

  // The script: each phase schedules the next.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    if (phase === 'title') {
      sound.drumroll();
      later(TITLE_MS, () => {
        sound.fanfare();
        celebrate({ colours: [arcade.gold, arcade.bonus, '#ffffff'], count: 180, y: 0.3 });
        setPhase('stats');
      });
    } else if (phase === 'stats') {
      for (let i = 1; i <= STAT_LINES; i++) {
        later(i * STAT_GAP_MS, () => {
          sound.tap();
          setLines(i);
        });
      }
      later((STAT_LINES + 1) * STAT_GAP_MS + 300, () => setPhase('convert'));
    } else if (phase === 'convert') {
      const start = performance.now();
      let ticks = 0;
      let frame = requestAnimationFrame(function step(t) {
        const p = Math.min(1, (t - start) / CONVERT_MS);
        setProgress(p);
        if (Math.floor(p * 16) > ticks) moneySound.clink(ticks++);
        if (p < 1) frame = requestAnimationFrame(step);
        else {
          sound.chaching();
          later(700, () => setPhase(hasEnvelopes ? 'envelopes' : 'pour'));
        }
      });
      return () => {
        cancelAnimationFrame(frame);
        timers.forEach(clearTimeout);
      };
    } else if (phase === 'envelopes') {
      sound.whoosh();
      later(300, () => sound.chime());
      later(ENVELOPE_MS + 600, () => setPhase('pour'));
    } else if (phase === 'finale') {
      sound.fanfare();
      celebrate({ colours: [arcade.gold, arcade.bonus, '#ffffff'], count: 200 });
      later(FINALE_MS, onClose);
    }
    return () => timers.forEach(clearTimeout);
  }, [phase, hasEnvelopes, onClose]);

  // What each child had to sort when the show reached the pouring step. A column with
  // nothing to sort is done by itself.
  const [toSortAtPour, setToSortAtPour] = useState<Map<number, number> | null>(null);
  useEffect(() => {
    if (phase === 'pour' && !toSortAtPour) {
      setToSortAtPour(new Map(players.map((c) => [c.id, c.money.toSortCents])));
    }
  }, [phase, toSortAtPour, players]);
  const needsPour = (child: KioskChild) => (toSortAtPour?.get(child.id) ?? 0) > 0;
  const allDone =
    toSortAtPour !== null && columns.every(({ child }) => done.has(child.id) || !needsPour(child));
  useEffect(() => {
    if (phase === 'pour' && allDone) setPhase('finale');
  }, [phase, allDone]);

  const showStats = phase === 'stats' || phase === 'convert' || phase === 'envelopes';
  const converting = phase !== 'title' && phase !== 'stats';

  return (
    <motion.div
      className={classes.show}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <h1 className={classes.showTitle}>
        <span>💰</span>IT’S PAYDAY!<span>💰</span>
      </h1>
      <p className={classes.showSub}>Let’s see what you earned this week</p>

      <div
        className={classes.showCols}
        style={{ '--cols': Math.max(1, columns.length) } as CSSProperties}
      >
        {columns.map(({ s, child }) => (
          <section
            key={child.id}
            className={classes.showCol}
            style={{ '--c': child.colour } as CSSProperties}
            data-done={(phase === 'pour' && (done.has(child.id) || !needsPour(child))) || undefined}
          >
            <div className={classes.showHead}>
              <div className={classes.showAvatar}>{child.avatar}</div>
              <h3>{child.name}</h3>
            </div>

            {showStats && (
              <div>
                {[
                  ['⚔️ Quests done', String(s.stats.questsDone)],
                  ['⚡ Early bonuses', String(s.stats.earlyBonuses)],
                  ['🦸 Did it without being asked', String(s.stats.unprompted)],
                  [
                    '🏅 Best day',
                    s.stats.bestDay
                      ? `${shortDayName(s.stats.bestDay.date)} · ${s.stats.bestDay.points} pts`
                      : '–',
                  ],
                ]
                  .slice(0, lines)
                  .map(([label, value]) => (
                    <motion.div
                      key={label}
                      className={classes.statRow}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                    >
                      <span>{label}</span>
                      <b>{value}</b>
                    </motion.div>
                  ))}
              </div>
            )}

            {converting && (
              <div className={classes.convert}>
                <div>
                  <div className={classes.convertPoints}>
                    {Math.round(s.points * (1 - progress))}
                  </div>
                  <div className={classes.caption}>points</div>
                </div>
                <div className={classes.convertArrow}>➡️</div>
                <div>
                  <div className={classes.convertMoney}>
                    {money(Math.round(s.cents * progress), currency)}
                  </div>
                  <div className={classes.caption}>
                    {rateCaption(summary.centsPerPoint, currency)}
                  </div>
                </div>
              </div>
            )}

            {(phase === 'envelopes' || phase === 'pour') &&
              s.envelopes.map((e) => (
                <motion.div
                  key={e.id}
                  className={classes.showEnvelope}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                >
                  <span>💌 From {e.fromName}</span>
                  <b>+{money(e.cents, currency)}</b>
                </motion.div>
              ))}

            {(phase === 'pour' || phase === 'finale') && toSortAtPour && (
              <PourColumn
                child={child}
                currency={currency}
                started={toSortAtPour.get(child.id) ?? 0}
                done={done.has(child.id)}
                onDone={() => {
                  sound.tap();
                  setDone((d) => new Set(d).add(child.id));
                }}
              />
            )}
          </section>
        ))}
      </div>

      <AnimatePresence>
        {phase === 'finale' && (
          <motion.div
            className={classes.finale}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
          >
            👍 See you next payday!
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** Step 5: "Hold your jars to pour in your pay!", then Done. */
function PourColumn({
  child,
  currency,
  started,
  done,
  onDone,
}: {
  child: KioskChild;
  currency: string;
  /** What there was to sort when the show reached this step. */
  started: number;
  done: boolean;
  onDone: () => void;
}) {
  const jarMoney = useJarMoney(child);
  const toSortRef = useRef<HTMLSpanElement>(null);
  const feedback = useMoneyFeedback(child, currency);

  if (started <= 0) {
    return <div className={classes.doneNote}>Nothing to sort this week</div>;
  }
  if (done) {
    return (
      <div className={classes.doneNote}>
        {jarMoney.toSortCents > 0
          ? `👍 ${money(jarMoney.toSortCents, currency)} kept to sort later`
          : '🎉 All sorted!'}
      </div>
    );
  }
  return (
    <>
      <div className={classes.pourHint}>✊ Hold your jars to pour in your pay!</div>
      <div className={classes.showToSort}>
        🪙 To sort{' '}
        <b ref={toSortRef} className={feedback.shake ? classes.shake : undefined}>
          {money(jarMoney.toSortCents, currency)}
        </b>
      </div>
      {jarMoney.jars.length === 0 ? (
        <div className={classes.caption} style={{ fontSize: 22 }}>
          Make a jar on the savings screen to start saving!
        </div>
      ) : (
        <div className={classes.showJars}>
          {jarMoney.jars
            .filter((j) => !j.smashed)
            .map((jar) => (
              <ShowJar
                key={jar.id}
                jar={jar}
                child={child}
                currency={currency}
                money={jarMoney}
                from={() => toSortRef.current?.getBoundingClientRect() ?? null}
                onEmpty={(rect) => feedback.empty(rect, null)}
                onMilestone={(cents) => feedback.milestone(jar, cents)}
                onFull={() => feedback.full(jar)}
              />
            ))}
        </div>
      )}
      <button type="button" className={classes.doneButton} onClick={onDone}>
        ✓ Done (keep the rest to sort later)
      </button>
      {feedback.node}
    </>
  );
}

function ShowJar({
  jar,
  child,
  currency,
  money: jarMoney,
  from,
  onEmpty,
  onMilestone,
  onFull,
}: {
  jar: ShownJar;
  child: KioskChild;
  currency: string;
  money: JarMoney;
  from: () => DOMRect | null;
  onEmpty: (rect: DOMRect | null) => void;
  onMilestone: (cents: number) => void;
  onFull: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const hold = usePourHold(jarMoney, jar, {
    onEmpty: () => onEmpty(ref.current?.getBoundingClientRect() ?? null),
    onMilestone,
    onFull,
    from,
    to: () => ref.current?.getBoundingClientRect() ?? null,
  });
  const m = (cents: number) => money(cents, currency);
  return (
    <button ref={ref} type="button" className={classes.showJar} {...hold}>
      <Jar
        fill={jar.progress.fill}
        emoji={jar.emoji}
        colour={child.colour}
        width={96}
        glow={jar.progress.full}
      />
      <b>{jar.name}</b>
      <span>
        <em>{m(jar.inCents)}</em>{' '}
        {jar.progress.big && jar.progress.nextMilestoneCents !== null
          ? `→ ⭐ ${formatMoneyShort(jar.progress.nextMilestoneCents, currency)}`
          : `/ ${m(jar.targetCents)}`}
      </span>
    </button>
  );
}
