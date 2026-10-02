import { claimPoints, type KioskChild, type KioskQuest } from '@pmp/shared';
import { motion } from 'framer-motion';
import { useEffect, useState, type CSSProperties } from 'react';
import { api, ApiError } from '../../lib/api';
import { sound } from '../../lib/sounds';
import classes from './kiosk.module.css';

/** What a refused claim says to the child (the server's `error` codes). */
const REFUSALS: Record<string, string> = {
  'parent-session': 'A grown-up is using the screen. Try again in a minute!',
  'not-open': 'That one is already done!',
  'not-today': "That was yesterday's quest.",
  'wrong-child': "That's not your quest.",
};

/**
 * The claim pop-up (spec 001, "Claiming a quest"), in the child's colour. It only sends the
 * claim: the animation plays when the server's `instance.claimed` event comes back
 * (`KioskCelebrations`), on this kiosk and every other one.
 */
export function ClaimSheet({
  quest,
  child,
  now,
  onClose,
}: {
  quest: KioskQuest;
  child: KioskChild;
  now: number;
  onClose: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Points if claimed right now, on the server's clock (the server scores it again).
  const points = (unprompted: boolean) =>
    claimPoints(quest.loot, quest.window, now, unprompted).total;

  const send = async (unprompted: boolean) => {
    setSending(true);
    setRefusal(null);
    try {
      await api.claim(quest.id, { childId: child.id, unprompted });
      onClose();
    } catch (err) {
      sound.sad();
      setRefusal(
        (err instanceof ApiError && err.code && REFUSALS[err.code]) ||
          'Something went wrong. Try again!',
      );
      setSending(false);
    }
  };

  return (
    <motion.div
      className={classes.sheetBackdrop}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <motion.div
        className={classes.sheet}
        style={{ '--c': child.colour } as CSSProperties}
        role="dialog"
        aria-modal
        aria-label={quest.title}
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 22 }}
      >
        <div className={classes.sheetIcon}>{quest.icon}</div>
        <h3>{quest.title}</h3>
        <p>Nice one, {child.name}! Did you do it without being asked?</p>
        <div className={classes.sheetButtons}>
          <button
            type="button"
            className={`${classes.sheetButton} ${classes.sheetYes}`}
            disabled={sending}
            onClick={() => void send(true)}
          >
            🦸 Yes, all by myself! (+{points(true)})
          </button>
          <button
            type="button"
            className={`${classes.sheetButton} ${classes.sheetReminded}`}
            disabled={sending}
            onClick={() => void send(false)}
          >
            🙋 Someone reminded me (+{points(false)})
          </button>
          <button
            type="button"
            className={`${classes.sheetButton} ${classes.sheetCancel}`}
            onClick={onClose}
          >
            Oops, not done yet
          </button>
        </div>
        {refusal && <div className={classes.sheetError}>{refusal}</div>}
      </motion.div>
    </motion.div>
  );
}
