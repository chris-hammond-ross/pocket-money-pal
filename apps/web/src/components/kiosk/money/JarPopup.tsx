import { amountStepCents, milestonesCrossed, quickAmounts, type KioskChild } from '@pmp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../../lib/api';
import { moneySound, sound } from '../../../lib/sounds';
import { flyTokens } from './fly';
import { Jar } from './Jar';
import classes from './money.module.css';
import { money, type JarMoney, type ShownJar } from './use-jar-money';

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
  const step = amountStepCents(max);
  const [amount, setAmount] = useState(() => Math.min(100, max));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const jarRef = useRef<HTMLDivElement>(null);
  const m = (cents: number) => money(cents, currency);

  // Keep the amount within what can move (after a move, or switching tabs).
  const shown = Math.min(Math.max(amount, max > 0 ? Math.min(step, max) : 0), max);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const switchTab = (next: Tab) => {
    sound.tap();
    setTab(next);
    const nextMax = next === 'in' ? jar.limits.maxIn : jar.limits.maxOut;
    setAmount(Math.min(100, nextMax));
  };

  const go = async () => {
    if (busy || shown <= 0) return;
    setBusy(true);
    const cents = tab === 'in' ? shown : -shown;
    const before = jar.inCents;
    const sort = toSortRect();
    const target = jarRef.current?.getBoundingClientRect() ?? null;
    if (sort && target) {
      const count = Math.min(10, Math.max(3, Math.round(shown / 50)));
      void flyTokens(tab === 'in' ? sort : target, tab === 'in' ? target : sort, {
        count,
        staggerMs: 60,
        durationMs: 480,
        onLand: (i) => moneySound.clink(i),
      });
    }
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
        style={{ '--c': child.colour } as CSSProperties}
        role="dialog"
        aria-modal
        aria-label={jar.name}
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 480, damping: 30 }}
      >
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
            <button
              type="button"
              data-on={tab === 'in' || undefined}
              onClick={() => switchTab('in')}
            >
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
          {max <= 0 ? (
            <div className={classes.reason}>{reason}</div>
          ) : (
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
                data-out={tab === 'out' || undefined}
                disabled={busy}
                onClick={() => void go()}
              >
                {tab === 'in' ? `⬆ Put ${m(shown)} in the jar` : `↩ Take ${m(shown)} out to sort`}
              </button>
            </>
          )}
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
        <button type="button" className={classes.closeLink} onClick={onClose}>
          Close
        </button>
      </motion.div>
    </motion.div>
  );
}
