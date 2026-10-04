import {
  crossedTier,
  flameTier,
  streakReportMessage,
  tierPillText,
  type KioskChild,
  type StreakReport,
} from '@pmp/shared';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { confettiFrom } from '../../lib/confetti';
import { sound } from '../../lib/sounds';
import { Flame, flameColours } from '../Flame';
import classes from './kiosk.module.css';

/** The big flame waits this long in the old colour before it changes. */
const REVEAL_MS = 1100;
/** It closes itself after this long. */
const CLOSE_MS = 12_000;

/**
 * The morning report (spec 005): over one child's column, how yesterday went and what it
 * did to their flame. It grows, changes colour, or goes out. Everything it shows comes
 * from the server's report; this only animates it.
 */
export function MorningReport({
  child,
  report,
  onClose,
}: {
  child: KioskChild;
  report: StreakReport;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const flameRef = useRef<HTMLDivElement>(null);
  const message = streakReportMessage(report);
  const missed = report.result === 'missed';
  const crossed = missed ? null : crossedTier(report.before, report.after);
  const days = revealed ? report.after : report.before;
  const tier = revealed && !missed ? flameTier(report.after) : flameTier(report.before);
  const colour = flameColours(tier).text;

  useEffect(() => {
    const reveal = setTimeout(() => {
      setRevealed(true);
      if (missed) sound.fizzle();
      else if (crossed) {
        sound.fanfare();
        const rect = flameRef.current?.getBoundingClientRect();
        const c = flameColours(flameTier(report.after)).text;
        if (rect) setTimeout(() => confettiFrom(rect, [c, '#ffffff', c], 120), 500);
      } else sound.grow();
    }, REVEAL_MS);
    const close = setTimeout(onClose, CLOSE_MS);
    return () => {
      clearTimeout(reveal);
      clearTimeout(close);
    };
    // The report is fixed for this overlay's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const yesterday =
    missed && report.missedQuest ? (
      <>
        Yesterday: <b className={classes.reportMissed}>{report.missedQuest}</b> didn’t get done
      </>
    ) : missed ? (
      'Yesterday didn’t get finished'
    ) : report.dates.length > 1 ? (
      `The last ${report.dates.length} days: every quest done ✅`
    ) : (
      'Yesterday: every quest done ✅'
    );

  return (
    <motion.div
      className={classes.report}
      style={{ '--tc': colour } as CSSProperties}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-label={`Good morning, ${child.name}`}
    >
      <div className={classes.reportHi}>GOOD MORNING, {child.name.toUpperCase()}!</div>
      <div className={classes.reportYesterday}>{yesterday}</div>
      <div
        ref={flameRef}
        className={classes.bigFlame}
        data-moment={revealed ? (missed ? 'out' : crossed ? 'recolour' : 'grow') : undefined}
      >
        <Flame tier={tier} className={classes.bigFlameSvg} />
        <span className={classes.smoke}>💨</span>
        <span className={`${classes.smoke} ${classes.smoke2}`}>💨</span>
      </div>
      <motion.div
        key={days}
        className={classes.reportCount}
        data-zero={days === 0 || undefined}
        initial={revealed ? { scale: 0.6 } : false}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 12 }}
      >
        {days}
        <small>day streak</small>
      </motion.div>
      <div className={classes.reportMessage}>{revealed ? message.text : ' '}</div>
      {revealed && crossed && (
        <motion.div
          className={classes.reportPill}
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.9, type: 'spring', stiffness: 400, damping: 14 }}
        >
          {tierPillText(crossed)}
        </motion.div>
      )}
      <button
        type="button"
        className={classes.reportGo}
        onClick={() => {
          sound.tap();
          onClose();
        }}
      >
        Let’s go! ▶
      </button>
    </motion.div>
  );
}
