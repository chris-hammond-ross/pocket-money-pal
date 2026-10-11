import { amountStepCents, milestonesCrossed, quickAmounts, type KioskChild } from '@pmp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../../../lib/api';
import { moneySound, sound } from '../../../lib/sounds';
import { flyTokens } from './fly';
import { Jar } from './Jar';
import classes from './money.module.css';
import { Piggy } from './Piggy';
import { money, PIGGY, type JarMoney, type ShownJar } from './use-jar-money';

type Tab = 'in' | 'out';

/**
 * The jar pop-up (spec 004): put coins in from "to sort" or take them out, with − / + and
 * quick amounts, and delete the jar. The frame stays put while it's used; only its
 * contents change. It stays open after a move so the child sees the jar fill.
 */
export function JarPopup({
  jar,
  child,
  currency,
  countdown,
  money: jarMoney,
  toSortRect,
  onMilestone,
  onFull,
  onClose,
}: {
  jar: ShownJar;
  child: KioskChild;
  currency: string;
  countdown: string | null;
  money: JarMoney;
  toSortRect: () => DOMRect | null;
  onMilestone: (cents: number) => void;
  onFull: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>(() => (jar.limits.maxIn > 0 ? 'in' : 'out'));
  const max = tab === 'in' ? jar.limits.maxIn : jar.limits.maxOut;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const jarRef = useRef<HTMLDivElement>(null);
  const m = (cents: number) => money(cents, currency);
  useEscape(onClose);

  const switchTab = (next: Tab) => {
    sound.tap();
    setTab(next);
  };

  const go = async (shown: number) => {
    if (busy || shown <= 0) return;
    setBusy(true);
    const cents = tab === 'in' ? shown : -shown;
    const before = jar.inCents;
    flyBetween(toSortRect(), jarRef.current, shown, tab === 'in');
    const ok = await jarMoney.commit(jar.id, cents);
    setBusy(false);
    if (!ok || tab !== 'in') return;
    for (const milestone of milestonesCrossed(before, before + cents, jar.targetCents)) {
      onMilestone(milestone);
    }
    if (before + cents >= jar.targetCents) onFull();
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteGoal(jar.id);
      moneySound.quietSmash();
      void queryClient.invalidateQueries({ queryKey: ['kiosk-today'] });
      onClose();
    } catch {
      sound.sad();
      setBusy(false);
      setConfirming(false);
    }
  };

  const reason =
    tab === 'in'
      ? jar.progress.full
        ? '🎉 This jar is full!'
        : `Nothing to sort yet. More coins at payday${countdown ? ` (${countdown})` : ''}`
      : 'This jar is empty';

  return (
    <PopFrame colour={child.colour} label={jar.name} onClose={onClose}>
      <div ref={jarRef}>
        <Jar
          fill={jar.progress.fill}
          emoji={jar.emoji}
          colour={child.colour}
          width={92}
          glow={jar.progress.full}
        />
      </div>
      <h3>{jar.name}</h3>
      <div className={classes.popLine}>
        {m(jar.inCents)} in this jar · {m(jarMoney.toSortCents)} to sort
      </div>

      <div className={classes.popPanel}>
        <div className={classes.popTabs}>
          <button type="button" data-on={tab === 'in' || undefined} onClick={() => switchTab('in')}>
            ⬆ Put coins in
          </button>
          <button
            type="button"
            data-on={tab === 'out' || undefined}
            onClick={() => switchTab('out')}
          >
            ↩ Take coins out
          </button>
        </div>
        <AmountPanel
          key={tab}
          max={max}
          currency={currency}
          reason={reason}
          busy={busy}
          out={tab === 'out'}
          label={(shown) =>
            tab === 'in' ? `⬆ Put ${m(shown)} in the jar` : `↩ Take ${m(shown)} out to sort`
          }
          onGo={(shown) => void go(shown)}
        />
      </div>

      {confirming ? (
        <div className={classes.confirm}>
          Delete the {jar.name} jar?
          {jar.inCents > 0 ? ` Its ${m(jar.inCents)} goes back to 🪙 to sort.` : ''}
          <div>
            <button
              type="button"
              className={classes.confirmYes}
              disabled={busy}
              onClick={() => void remove()}
            >
              Yes, delete it
            </button>
            <button
              type="button"
              className={classes.confirmNo}
              onClick={() => setConfirming(false)}
            >
              No, keep it
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={classes.deleteButton}
          onClick={() => {
            sound.tap();
            setConfirming(true);
          }}
        >
          🗑 Delete this jar
        </button>
      )}
    </PopFrame>
  );
}

/**
 * The piggy bank's pop-up (ADR 0019): put coins in from "to sort". Nothing comes back out
 * on the kiosk, so there's no "take out" tab and no delete.
 */
export function PiggyPopup({
  child,
  currency,
  countdown,
  money: jarMoney,
  toSortRect,
  onClose,
}: {
  child: KioskChild;
  currency: string;
  countdown: string | null;
  money: JarMoney;
  toSortRect: () => DOMRect | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const piggyRef = useRef<HTMLDivElement>(null);
  const m = (cents: number) => money(cents, currency);
  const { piggy } = jarMoney;
  useEscape(onClose);

  const go = async (shown: number) => {
    if (busy || shown <= 0) return;
    setBusy(true);
    flyBetween(toSortRect(), piggyRef.current, shown, true);
    await jarMoney.commit(PIGGY, shown);
    setBusy(false);
  };

  return (
    <PopFrame colour={child.colour} label="Piggy bank" onClose={onClose}>
      <div ref={piggyRef}>
        <Piggy width={120} />
      </div>
      <h3>Piggy bank</h3>
      <div className={classes.popLine}>
        {m(piggy.inCents)} saved in here · {m(jarMoney.toSortCents)} to sort
      </div>
      <div className={classes.popPanel}>
        <AmountPanel
          max={piggy.limits.maxIn}
          currency={currency}
          reason={`Nothing to sort yet. More coins at payday${countdown ? ` (${countdown})` : ''}`}
          busy={busy}
          label={(shown) => `⬆ Put ${m(shown)} in the piggy bank`}
          onGo={(shown) => void go(shown)}
        />
      </div>
      <div className={classes.piggyNote}>
        🔒 Piggy bank money stays saved. Ask a grown-up if you need some.
      </div>
    </PopFrame>
  );
}

/** Closes a pop-up on Escape. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

/** Coins fly between the "To sort" tile and the jar (or piggy bank) as a move is sent. */
function flyBetween(sort: DOMRect | null, el: HTMLElement | null, cents: number, into: boolean) {
  const target = el?.getBoundingClientRect() ?? null;
  if (!sort || !target) return;
  const count = Math.min(10, Math.max(3, Math.round(cents / 50)));
  void flyTokens(into ? sort : target, into ? target : sort, {
    count,
    staggerMs: 60,
    durationMs: 480,
    onLand: (i) => moneySound.clink(i),
  });
}

/** The pop-up's frame in the child's colour. It stays put while its contents change. */
function PopFrame({
  colour,
  label,
  onClose,
  children,
}: {
  colour: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <motion.div
      className={classes.popBackdrop}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <motion.div
        className={classes.pop}
        style={{ '--c': colour } as CSSProperties}
        role="dialog"
        aria-modal
        aria-label={label}
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 480, damping: 30 }}
      >
        {children}
        <button type="button" className={classes.closeLink} onClick={onClose}>
          Close
        </button>
      </motion.div>
    </motion.div>
  );
}

/**
 * How much to move: big − and + (10p steps, or 50p once the most is £5 or more), quick
 * amounts and "All", then the action button. When nothing can move, `reason` says why.
 * Remount it (a new `key`) to start again from £1.
 */
function AmountPanel({
  max,
  currency,
  reason,
  busy,
  out = false,
  label,
  onGo,
}: {
  max: number;
  currency: string;
  reason: string;
  busy: boolean;
  out?: boolean;
  label: (shown: number) => string;
  onGo: (shown: number) => void;
}) {
  const step = amountStepCents(max);
  const [amount, setAmount] = useState(() => Math.min(100, max));
  const m = (cents: number) => money(cents, currency);
  // Keep the amount within what can move (after a move, or when "to sort" changes).
  const shown = Math.min(Math.max(amount, max > 0 ? Math.min(step, max) : 0), max);

  if (max <= 0) return <div className={classes.reason}>{reason}</div>;
  return (
    <>
      <div className={classes.amountRow}>
        <button
          type="button"
          className={classes.roundButton}
          disabled={shown <= step}
          onClick={() => {
            sound.tap();
            setAmount(Math.max(step, shown - step));
          }}
          aria-label="Less"
        >
          −
        </button>
        <b>{m(shown)}</b>
        <button
          type="button"
          className={classes.roundButton}
          disabled={shown >= max}
          onClick={() => {
            sound.tap();
            setAmount(Math.min(max, shown + step));
          }}
          aria-label="More"
        >
          +
        </button>
      </div>
      <div className={classes.chips}>
        {quickAmounts(max).map((q) => (
          <button
            key={q}
            type="button"
            data-on={shown === q || undefined}
            onClick={() => {
              sound.tap();
              setAmount(q);
            }}
          >
            {m(q).replace(/\.00$/, '')}
          </button>
        ))}
        <button
          type="button"
          data-on={shown === max || undefined}
          onClick={() => {
            sound.tap();
            setAmount(max);
          }}
        >
          All {m(max)}
        </button>
      </div>
      <button
        type="button"
        className={classes.actionButton}
        data-out={out || undefined}
        disabled={busy}
        onClick={() => onGo(shown)}
      >
        {label(shown)}
      </button>
    </>
  );
}
