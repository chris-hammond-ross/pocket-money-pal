import {
  formatMoneyShort,
  jarStatsText,
  PAYDAY_DAY_NAMES,
  type KioskChild,
  type PaydayInfo,
  type SavingsRow,
} from '@pmp/shared';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../../lib/api';
import { useLatest } from '../../../lib/use-latest';
import { celebrate } from '../../../lib/confetti';
import { sound } from '../../../lib/sounds';
import { arcade } from '../../../theme';
import { Jar, type JarMark } from './Jar';
import { JarPopup } from './JarPopup';
import classes from './money.module.css';
import {
  money,
  paydayCountdown,
  usePourHold,
  useJarMoney,
  type JarMoney,
  type ShownJar,
} from './use-jar-money';

/** The savings screen closes by itself after this long without a touch (spec 004). */
const IDLE_CLOSE_MS = 60_000;
const SMASH_HOLD_MS = 1_500;

export interface MoneyContext {
  currency: string;
  timezone: string;
  payday: PaydayInfo;
  now: number;
}

/**
 * A child's savings screen (spec 004): the savings book on the left, and the jars on the
 * right. Hold a jar to pour coins in from "to sort"; tap it for the jar pop-up.
 */
export function SavingsScreen({
  child,
  ctx,
  onClose,
  onNewJar,
}: {
  child: KioskChild;
  ctx: MoneyContext;
  onClose: () => void;
  onNewJar: () => void;
}) {
  const jarMoney = useJarMoney(child);
  const [popupId, setPopupId] = useState<number | null>(null);
  const toSortRef = useRef<HTMLDivElement>(null);
  const feedback = useMoneyFeedback(child, ctx.currency);
  useIdleClose(onClose, IDLE_CLOSE_MS);

  const countdown = paydayCountdown(ctx.payday, ctx.now);
  const popupJar = jarMoney.jars.find((j) => j.id === popupId);

  return (
    <motion.div
      className={classes.overlay}
      style={{ '--c': child.colour } as CSSProperties}
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 30 }}
      transition={{ duration: 0.2 }}
    >
      <header className={classes.overlayHead}>
        <div className={classes.overlayAvatar}>{child.avatar}</div>
        <div>
          <h2>{child.name}’s savings</h2>
          <p>
            Payday every {PAYDAY_DAY_NAMES[ctx.payday.day]} · then you choose which jars to fill
          </p>
        </div>
        <button type="button" className={classes.backButton} onClick={onClose}>
          ◀ Back to quests
        </button>
      </header>

      <div className={classes.savingsBody}>
        <SavingsBook
          child={child}
          ctx={ctx}
          countdown={countdown}
          toSortCents={jarMoney.toSortCents}
          toSortRef={toSortRef}
          shake={feedback.shake}
        />
        <div className={classes.jarsGrid}>
          {jarMoney.jars.map((jar) => (
            <JarCard
              key={jar.id}
              jar={jar}
              child={child}
              currency={ctx.currency}
              money={jarMoney}
              from={() => toSortRef.current?.getBoundingClientRect() ?? null}
              onTap={() => {
                sound.tap();
                setPopupId(jar.id);
              }}
              onEmpty={(rect) => feedback.empty(rect, countdown)}
              onMilestone={(cents) => feedback.milestone(jar, cents)}
              onFull={() => feedback.full(jar)}
            />
          ))}
          <button type="button" className={classes.newJarCard} onClick={onNewJar}>
            <span>+</span>
            New jar
          </button>
        </div>
      </div>

      <AnimatePresence>
        {popupJar && (
          <JarPopup
            key={popupJar.id}
            jar={popupJar}
            child={child}
            currency={ctx.currency}
            countdown={countdown}
            money={jarMoney}
            toSortRect={() => toSortRef.current?.getBoundingClientRect() ?? null}
            onMilestone={(cents) => feedback.milestone(popupJar, cents)}
            onFull={() => feedback.full(popupJar)}
            onClose={() => setPopupId(null)}
          />
        )}
      </AnimatePresence>
      {feedback.node}
    </motion.div>
  );
}

function SavingsBook({
  child,
  ctx,
  countdown,
  toSortCents,
  toSortRef,
  shake,
}: {
  child: KioskChild;
  ctx: MoneyContext;
  countdown: string | null;
  toSortCents: number;
  toSortRef: React.RefObject<HTMLDivElement | null>;
  shake: boolean;
}) {
  const book = useQuery({ queryKey: ['savings', child.id], queryFn: () => api.savings(child.id) });
  const m = (cents: number) => money(cents, ctx.currency);
  const signed = (cents: number) => (cents < 0 ? `−${m(-cents)}` : `+${m(cents)}`);
  const date = (at: number) =>
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: ctx.timezone,
    }).format(at);

  return (
    <section className={classes.book}>
      <h3 className={classes.bookTitle}>📒 Savings book</h3>
      <div className={classes.bookTiles}>
        <div className={classes.bookTile}>
          Saved
          <b>{m(child.money.savedCents)}</b>
        </div>
        <div className={classes.bookTile} data-tone="green">
          {countdown === null ? 'Payday soon' : `Payday in ${countdown}`}
          <b>+{m(Math.max(0, child.money.unconvertedCents))}</b>
        </div>
        <div
          ref={toSortRef}
          className={`${classes.bookTile} ${shake ? classes.shake : ''}`}
          data-tone="gold"
        >
          🪙 To sort
          <b>{m(toSortCents)}</b>
        </div>
      </div>
      <div className={classes.bookScroll}>
        <table className={classes.bookTable}>
          <thead>
            <tr>
              <th>Week</th>
              <th className={classes.n}>Quests</th>
              <th className={classes.n}>Points</th>
              <th className={classes.n}>Money</th>
              <th className={classes.n}>Saved</th>
            </tr>
          </thead>
          <tbody>
            {book.data && (
              <>
                <tr className={classes.bookWeek}>
                  <td className={classes.what}>
                    ⏳ This week so far <span className={classes.stamp}>NEXT PAYDAY</span>
                  </td>
                  <td className={classes.n}>{book.data.thisWeek.quests}</td>
                  <td className={classes.n}>{book.data.thisWeek.points}</td>
                  <td className={classes.n}>{m(book.data.thisWeek.cents)}</td>
                  <td />
                </tr>
                {book.data.jars.map((j) => (
                  <tr key={`jar-${j.id}`} className={classes.bookJarLine}>
                    <td className={classes.what} colSpan={4}>
                      &nbsp;↳ in the {j.emoji} {j.name} jar
                    </td>
                    <td className={classes.n}>{m(j.inCents)}</td>
                  </tr>
                ))}
                {book.data.rows.map((row) => (
                  <BookRow key={row.id} row={row} date={date} signed={signed} m={m} />
                ))}
              </>
            )}
          </tbody>
        </table>
        {book.data?.rows.length === 0 && (
          <div className={classes.bookEmpty}>Your first payday will be written here.</div>
        )}
      </div>
    </section>
  );
}

const ROW_ICONS: Record<SavingsRow['kind'], string> = {
  payday: '💰',
  gift: '🎁',
  spend: '🛒',
  bought: '🔨',
};

function BookRow({
  row,
  date,
  signed,
  m,
}: {
  row: SavingsRow;
  date: (at: number) => string;
  signed: (cents: number) => string;
  m: (cents: number) => string;
}) {
  const what =
    row.kind === 'payday'
      ? `Payday · ${date(row.dateAt)}`
      : row.kind === 'bought'
        ? `Bought the ${row.jar?.emoji ?? ''} ${row.jar?.name ?? row.note} · ${date(row.at)}`
        : `${row.note ?? ''}${row.jar ? ` (from the ${row.jar.name} jar)` : ''} · ${date(row.at)}`;
  return (
    <tr className={row.kind === 'payday' ? classes.bookPayday : undefined}>
      <td className={classes.what}>
        {ROW_ICONS[row.kind]} {what}
      </td>
      <td className={classes.n}>{row.quests ?? ''}</td>
      <td className={classes.n}>{row.points ?? ''}</td>
      <td className={`${classes.n} ${row.cents < 0 ? classes.bookNeg : ''}`}>
        {signed(row.cents)}
      </td>
      <td className={classes.n}>{m(row.balanceCents)}</td>
    </tr>
  );
}

/** Milestone ⭐ lines on a big jar: passed ones below the fill, and the next one at the top. */
export function jarMarks(jar: ShownJar, currency: string): JarMark[] {
  if (!jar.progress.big) return [];
  const top = jar.progress.fillToCents;
  const marks = jar.progress.passed
    .filter((m) => m < top)
    .map((m) => ({ at: m / top, label: `⭐${formatMoneyShort(m, currency)}`, passed: true }));
  if (!jar.progress.full) {
    marks.push({ at: 1, label: `⭐${formatMoneyShort(top, currency)}`, passed: false });
  }
  return marks;
}

function JarCard({
  jar,
  child,
  currency,
  money: jarMoney,
  from,
  onTap,
  onEmpty,
  onMilestone,
  onFull,
}: {
  jar: ShownJar;
  child: KioskChild;
  currency: string;
  money: JarMoney;
  from: () => DOMRect | null;
  onTap: () => void;
  onEmpty: (rect: DOMRect | null) => void;
  onMilestone: (cents: number) => void;
  onFull: () => void;
}) {
  const jarRef = useRef<HTMLDivElement>(null);
  const hold = usePourHold(jarMoney, jar, {
    onTap,
    onEmpty: () => onEmpty(jarRef.current?.getBoundingClientRect() ?? null),
    onMilestone,
    onFull,
    from,
    to: () => jarRef.current?.getBoundingClientRect() ?? null,
  });
  const { full, big } = jar.progress;
  const m = (cents: number) => money(cents, currency);

  if (jar.smashed) {
    return (
      <div
        className={classes.jarCard}
        data-smashed
        style={{ '--c': child.colour } as CSSProperties}
      >
        <Jar fill={1} emoji={jar.emoji} colour={child.colour} width={120} />
        <div className={classes.jarCardName}>{jar.name}</div>
        <div className={classes.smashedNote}>🛍️ Jar smashed! A grown-up is getting it</div>
      </div>
    );
  }

  return (
    <div
      className={classes.jarCard}
      data-full={full || undefined}
      style={{ '--c': child.colour } as CSSProperties}
      {...hold}
    >
      <div ref={jarRef}>
        <Jar
          fill={jar.progress.fill}
          emoji={jar.emoji}
          colour={child.colour}
          width={120}
          glow={full}
          marks={jarMarks(jar, currency)}
        />
      </div>
      <div className={classes.jarCardName}>{jar.name}</div>
      <div className={classes.jarCardAmount}>
        {m(jar.inCents)} / {m(big && !full ? jar.progress.fillToCents : jar.targetCents)}
      </div>
      {big && !full && (
        <div className={classes.jarCardSub}>
          {jar.progress.fillToCents < jar.targetCents ? '⭐ milestone · ' : ''}whole thing{' '}
          {m(jar.targetCents)}
        </div>
      )}
      {jar.stats && !full && (
        <div className={classes.jarCardStats}>{jarStatsText(jar.stats, currency)}</div>
      )}
      {!jar.priceChecked && <span className={classes.uncheckedTag}>🕓 price not checked yet</span>}
      {full && <SmashButton jarId={jar.id} />}
    </div>
  );
}

/** "🔨 Hold to smash": a 1.5-second hold with a filling ring (spec 004). */
function SmashButton({ jarId }: { jarId: number }) {
  const [progress, setProgress] = useState(0);
  const hold = useRef<{ start: number; timer: ReturnType<typeof setInterval>; done: boolean }>(
    null,
  );
  const smash = () => {
    const h = hold.current;
    if (!h || h.done) return;
    h.done = true;
    clearInterval(h.timer);
    void api.smashGoal(jarId).catch(() => sound.sad());
  };
  // Let go: smash if it was held long enough (timers can run late), else start again.
  const release = () => {
    const h = hold.current;
    if (h && !h.done && Date.now() - h.start >= SMASH_HOLD_MS) smash();
    if (h) clearInterval(h.timer);
    hold.current = null;
    setProgress(0);
  };
  useEffect(() => () => clearInterval(hold.current?.timer), []);
  return (
    <button
      type="button"
      className={classes.smashButton}
      style={{ '--p': `${progress * 100}%` } as CSSProperties}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const start = Date.now();
        hold.current = {
          start,
          done: false,
          timer: setInterval(() => {
            const p = Math.min(1, (Date.now() - start) / SMASH_HOLD_MS);
            setProgress(p);
            if (p >= 1) smash();
          }, 30),
        };
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        release();
      }}
      onPointerCancel={release}
    >
      <i />
      <span>🔨 Hold to smash</span>
    </button>
  );
}

/**
 * The savings screen's feedback: the toast for milestones, "jar full" with confetti, and
 * the shake and "Next coins at payday" when there's nothing to sort.
 */
export function useMoneyFeedback(child: KioskChild, currency: string) {
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [note, setNote] = useState<{ id: number; text: string; x: number; y: number } | null>(null);
  const [shake, setShake] = useState(false);
  const ids = useRef(0);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 1800);
    return () => clearTimeout(t);
  }, [note]);

  const empty = useCallback((rect: DOMRect | null, countdown: string | null) => {
    sound.sad();
    setShake(true);
    setTimeout(() => setShake(false), 500);
    if (rect) {
      setNote({
        id: ++ids.current,
        text: countdown ? `Next coins at payday · ${countdown}` : 'Next coins at payday',
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    }
  }, []);

  const milestone = useCallback(
    (jar: ShownJar, cents: number) => {
      sound.jingle();
      const next = jar.progress.milestones.find((x) => x > cents);
      const fmt = (c: number) => formatMoneyShort(c, currency);
      setToast({
        id: ++ids.current,
        text: `⭐ ${child.name}’s ${jar.name} jar passed ${fmt(cents)}!${next ? ` Next stop: ${fmt(next)}` : ''}`,
      });
    },
    [child.name, currency],
  );

  const full = useCallback(
    (jar: ShownJar) => {
      sound.fanfare();
      celebrate({ colours: [child.colour, arcade.gold, '#ffffff'] });
      setToast({ id: ++ids.current, text: `🎉 ${jar.emoji} ${jar.name} jar is full!` });
    },
    [child.colour],
  );

  const node = (
    <>
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            className={classes.toast}
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
          >
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {note && (
          <motion.div
            key={note.id}
            className={classes.floatNote}
            style={{ left: note.x, top: note.y }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: -20 }}
            exit={{ opacity: 0, y: -50 }}
          >
            {note.text}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );

  return { empty, milestone, full, shake, node };
}

/** Calls `onIdle` after `ms` with no touch, click or key anywhere. */
export function useIdleClose(onIdle: () => void, ms: number) {
  const latest = useLatest(onIdle);
  useEffect(() => {
    let timer = setTimeout(() => latest.current(), ms);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => latest.current(), ms);
    };
    const events = ['pointerdown', 'pointermove', 'keydown'] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, reset);
    };
  }, [ms, latest]);
}
