import {
  daysBetween,
  flameTier,
  pauseCountdown,
  type KioskChild,
  type SchedulePause,
} from '@pmp/shared';
import { motion } from 'framer-motion';
import { useEffect, type CSSProperties } from 'react';
import { formatDate } from '../../lib/format';
import { sound } from '../../lib/sounds';
import { Flame, flameColours } from '../Flame';
import classes from './holiday.module.css';

/**
 * The holiday screen (ADR 0016): while the pause covers today it takes the board's place.
 * A beach, the sleeps until the family is back, and each child's flame, safe while they're
 * away. "🍯 My jars" still opens their savings screen.
 */
export function HolidayScreen({
  pause,
  today,
  players,
  onSavings,
}: {
  pause: SchedulePause;
  today: string;
  players: readonly KioskChild[];
  onSavings: (childId: number) => void;
}) {
  const { backOn, sleeps } = pauseCountdown(pause, today);
  useEffect(() => {
    sound.chime();
  }, []);

  return (
    <motion.main
      className={classes.holiday}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.8 }}
    >
      <div className={classes.sun} aria-hidden />
      <div className={classes.sea} aria-hidden>
        <i />
        <i />
        <i />
      </div>

      <div className={classes.top}>
        <div className={classes.palm} aria-hidden>
          🌴
        </div>
        <h2 className={classes.title}>ON HOLIDAY!</h2>
        <p className={classes.lead}>
          Quests are paused.{' '}
          {backOn ? (
            <>
              Back on <b>{formatDate(backOn, 'long')}</b>.
            </>
          ) : (
            'They’ll be back when a game master says so.'
          )}
        </p>
        {sleeps !== null && (
          <motion.div
            className={classes.countdown}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.4, type: 'spring', stiffness: 180, damping: 12 }}
          >
            <span className={classes.sleeps}>{sleeps}</span>
            <span className={classes.sleepsLabel}>{sleeps === 1 ? 'SLEEP' : 'SLEEPS'} TO GO</span>
          </motion.div>
        )}
      </div>

      <div className={classes.players}>
        {players.map((child, i) => {
          const tier = flameTier(child.streak.days);
          return (
            <motion.div
              key={child.id}
              className={classes.player}
              style={{ '--c': child.colour } as CSSProperties}
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.6 + i * 0.12 }}
            >
              <span className={classes.avatar}>{child.avatar}</span>
              <b className={classes.name}>{child.name}</b>
              <div className={classes.streak} style={{ color: flameColours(tier).text }}>
                <Flame tier={tier} className={classes.flame} />
                <span>
                  {child.streak.days > 0
                    ? `🔒 ${child.streak.days}-day streak is safe`
                    : 'Light a streak when you’re back!'}
                </span>
              </div>
              <button
                type="button"
                className={classes.jars}
                onClick={() => {
                  sound.tap();
                  onSavings(child.id);
                }}
              >
                🍯 My jars
              </button>
            </motion.div>
          );
        })}
      </div>
    </motion.main>
  );
}

/** The header's heads-up while a pause is still to come: "🌴 Holiday from tomorrow!". */
export function HolidaySoonPill({ pause, today }: { pause: SchedulePause; today: string }) {
  const days = daysBetween(today, pause.from);
  return (
    <span className={classes.soonPill}>
      <span className={classes.soonPalm}>🌴</span>
      Holiday {days === 1 ? 'from tomorrow' : `from ${formatDate(pause.from, 'long')}`}!
    </span>
  );
}
