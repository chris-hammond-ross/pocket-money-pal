import { formatCountdown, type KioskChild, type KioskSurprise } from '@pmp/shared';
import { motion } from 'framer-motion';
import { useEffect, useState, type CSSProperties } from 'react';
import { api, ApiError } from '../../lib/api';
import { sound } from '../../lib/sounds';
import { arcade } from '../../theme';
import classes from './kiosk.module.css';

/** What a refused grab says, when it isn't simply the overlay closing. */
const REFUSALS: Record<string, string> = {
  'not-eligible': 'This one isn’t for you!',
};

/**
 * The surprise quest overlay (spec 001 "Surprise quest", spec 006 "Kiosk"): full screen,
 * with the alarm and a shake as it appears, the countdown, and "I'll do it!" for a child's
 * own surprise, or just "We'll all do it!" for a surprise for everyone (with only one
 * child who can take it, it's their "I'll do it!").
 *
 * A tap only sends the grab: the server settles the race, and the fanfare plays for its
 * `surprise.grabbed` event on every kiosk (`KioskCelebrations`). The overlay closes when
 * the board no longer has it live (grabbed, expired or taken back), or when its countdown
 * reaches zero here.
 */
export function SurpriseOverlay({
  surprise,
  players,
  now,
}: {
  surprise: KioskSurprise;
  players: readonly KioskChild[];
  now: number;
}) {
  const { run, canTeam, queued } = surprise;
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const takers = players.filter((c) => run.eligibleIds.includes(c.id));
  // A surprise for everyone is done together: nobody grabs it alone.
  const soloTakers = canTeam ? [] : takers;
  const left = (run.expiresAt ?? now) - now;

  // The alarm, once per surprise on this screen (muted in quiet hours, spec 005).
  useEffect(() => sound.alarm(), []);

  const send = async (grab: { childId: number } | { all: true }) => {
    sound.tap();
    setSending(true);
    setRefusal(null);
    try {
      await api.grabSurprise(run.id, grab);
    } catch (err) {
      // Lost the race or ran out of time: the server's event closes the overlay anyway.
      const code = err instanceof ApiError ? err.code : null;
      if (code && REFUSALS[code]) {
        sound.sad();
        setRefusal(REFUSALS[code]);
      }
      setSending(false);
    }
  };

  const line =
    run.who !== 'all'
      ? `Just for ${takers[0]?.name ?? 'one player'}!`
      : canTeam
        ? 'One for everyone, all together!'
        : `Just for ${takers[0]?.name ?? 'one player'} today!`;
  // Through the children's colours, with gold in the middle for two (spec 006).
  const colours = takers.map((c) => c.colour);
  const gradient = (colours.length === 2 ? [colours[0], arcade.gold, colours[1]] : colours).join(
    ', ',
  );

  return (
    <motion.div
      className={classes.surprise}
      role="dialog"
      aria-modal
      aria-label={`Surprise quest: ${run.title}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
    >
      <motion.div
        className={classes.surpriseCard}
        initial={{ scale: 0.6, rotate: 0 }}
        animate={{ scale: 1, rotate: [0, -3, 3, -2, 2, 0] }}
        transition={{
          scale: { type: 'spring', stiffness: 420, damping: 16 },
          rotate: { duration: 0.6, delay: 0.15 },
        }}
      >
        <h2 className={classes.surpriseHead}>
          <span>⚡</span> SURPRISE QUEST <span>⚡</span>
        </h2>
        <div className={classes.surpriseTitle}>
          <span>{run.icon}</span> {run.title}
        </div>
        <div className={classes.surprisePoints}>+{run.rewardPoints} points</div>
        <div className={classes.surpriseLine}>
          {line} · <b>{formatCountdown(left)}</b> left
        </div>
        {takers.length === 0 ? (
          <div className={classes.surpriseLine}>Nobody can take this one today.</div>
        ) : (
          <div
            className={classes.surpriseButtons}
            style={{ '--n': Math.max(1, soloTakers.length) } as CSSProperties}
          >
            {soloTakers.map((child) => (
              <button
                key={child.id}
                type="button"
                className={classes.grabButton}
                style={{ '--c': child.colour } as CSSProperties}
                disabled={sending}
                onClick={() => void send({ childId: child.id })}
              >
                {child.avatar} I’ll do it! {child.name}
              </button>
            ))}
            {canTeam && (
              <button
                type="button"
                className={`${classes.grabButton} ${classes.teamButton}`}
                style={{ '--team': `linear-gradient(90deg, ${gradient})` } as CSSProperties}
                disabled={sending}
                onClick={() => void send({ all: true })}
              >
                👫 We’ll all do it! <small>+{run.rewardPoints} each</small>
              </button>
            )}
          </div>
        )}
        {refusal && <div className={classes.sheetError}>{refusal}</div>}
      </motion.div>
      {queued > 0 && (
        <div className={classes.surpriseQueued}>
          +{queued} more {queued === 1 ? 'surprise' : 'surprises'} waiting
        </div>
      )}
    </motion.div>
  );
}
