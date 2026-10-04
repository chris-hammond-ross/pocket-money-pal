import {
  BUSY_UNFOLD_MS,
  busyFold,
  flameTier,
  isBusyDay,
  orderKioskQuests,
  type Envelope,
  type KioskChild,
  type KioskQuest,
  type PaydayInfo,
  type StreakReport,
} from '@pmp/shared';
import { AnimatePresence, motion, type Transition } from 'framer-motion';
import { useEffect, useState, type CSSProperties } from 'react';
import { sound } from '../../lib/sounds';
import { Flame, flameColours } from '../Flame';
import classes from './kiosk.module.css';
import { LootCard } from './money/LootCard';
import { MorningReport } from './MorningReport';
import { NextUp } from './NextUp';
import { ApprovedQuestRow, ClaimedQuestCard, OpenQuestCard } from './QuestCard';

const CARD_MOVE: Transition = { type: 'spring', stiffness: 380, damping: 32 };
const CARD_POP: Transition = { type: 'spring', stiffness: 520, damping: 20 };
const FADE_IN = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };

/** One child's column: player panel, Next-up countdown, quests, and the loot card. */
export function PlayerColumn({
  child,
  now,
  dayStart,
  timezone,
  payday,
  currency,
  ringing,
  report,
  onReportClose,
  onClaim,
  onSavings,
  onNewJar,
  onEnvelope,
}: {
  child: KioskChild;
  now: number;
  dayStart: number;
  timezone: string;
  payday: PaydayInfo;
  currency: string;
  /** Open quests on the board whose bonus is ending (spec 005). */
  ringing: Set<number>;
  /** The morning report playing over this column, if any. */
  report: StreakReport | undefined;
  onReportClose: () => void;
  onClaim: (quest: KioskQuest) => void;
  onSavings: () => void;
  onNewJar: () => void;
  onEnvelope: (envelope: Envelope) => void;
}) {
  // Re-ranked every tick with the same rule the server used, so cards move as stages change.
  const quests = orderKioskQuests(child.quests, now);
  const open = quests.filter((q) => q.status === 'open');
  const claimed = quests.filter((q) => q.status === 'claimed');
  const approved = quests.filter((q) => q.status === 'approved');
  const { level, xpIntoLevel, xpForThisLevel } = child.level;
  const isRinging = (q: KioskQuest) => ringing.has(q.id);
  const lastMinute = (q: KioskQuest) => q.window.bonusBefore - now <= 60_000;

  // Busy days (spec 005): the 3 most pressing open quests, then "+N MORE"; claims fold.
  const busy = isBusyDay(open.length + claimed.length);
  const [unfolded, setUnfolded] = useState(false);
  useEffect(() => {
    if (!unfolded) return;
    const timer = setTimeout(() => setUnfolded(false), BUSY_UNFOLD_MS);
    return () => clearTimeout(timer);
  }, [unfolded]);
  const fold = busy && !unfolded ? busyFold(open, isRinging) : { shown: open, folded: [] };
  const cards = busy ? fold.shown : [...open, ...claimed];
  const toggleFold = () => {
    sound.tap();
    setUnfolded((u) => !u);
  };

  return (
    <section
      className={classes.player}
      style={{ '--c': child.colour } as CSSProperties}
      data-child={child.id}
    >
      <div className={classes.hud}>
        <div className={classes.avatar} data-ringing={open.some(isRinging) || undefined}>
          {child.avatar}
          <span className={classes.alarmBubble} aria-hidden>
            ⏰
          </span>
        </div>
        <div style={{ minWidth: 0 }}>
          <h2 className={classes.name}>{child.name}</h2>
          <div className={classes.level}>LEVEL {level}</div>
          <div className={classes.xp}>
            <i style={{ width: `${(xpIntoLevel / xpForThisLevel) * 100}%` }} />
            <span>
              {xpIntoLevel} / {xpForThisLevel} XP
            </span>
          </div>
        </div>
        <div className={classes.stats}>
          <div className={classes.points} data-child-points={child.id}>
            {child.pointsToday}
          </div>
          <div className={classes.statLabel}>points today</div>
        </div>
        <StreakFlame days={child.streak.days} best={child.streak.best} />
      </div>

      <NextUp quest={open[0]} hadQuests={quests.length > 0} sick={child.sickToday} now={now} />

      {/* Claimed quests are done as far as the child is concerned: only open ones are left. */}
      <div className={classes.sectionTitle}>
        QUESTS · {open.length} LEFT{busy && ' · BUSY DAY!'}
      </div>
      {/*
       * One list, so a card keeps its key as it goes open → claimed → approved: `layout`
       * slides it to its new place, and the inner key on the status pops in the new look.
       */}
      <motion.div className={classes.quests} layoutScroll>
        <AnimatePresence initial={false}>
          {cards.map((q) => (
            <motion.div key={q.id} layout="position" transition={CARD_MOVE}>
              <motion.div
                key={q.status}
                initial={{ scale: 0.92, opacity: 0.4 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={CARD_POP}
              >
                {q.status === 'open' ? (
                  <OpenQuestCard
                    quest={q}
                    now={now}
                    dayStart={dayStart}
                    ringing={isRinging(q) ? (lastMinute(q) ? 'fast' : 'slow') : null}
                    onClaim={onClaim}
                  />
                ) : (
                  <ClaimedQuestCard quest={q} timezone={timezone} />
                )}
              </motion.div>
            </motion.div>
          ))}
          {busy && fold.folded.length > 0 && (
            <motion.button
              key="more"
              type="button"
              className={classes.moreRow}
              onClick={toggleFold}
              layout="position"
              {...FADE_IN}
            >
              <b>＋{fold.folded.length} MORE</b>
              <span className={classes.miniIcons}>{fold.folded.map((q) => q.icon).join('')}</span>
              <small>tap to see them</small>
            </motion.button>
          )}
          {busy && unfolded && (
            <motion.button
              key="less"
              type="button"
              className={classes.moreRow}
              onClick={toggleFold}
              layout="position"
              {...FADE_IN}
            >
              <b>▲ LESS</b>
              <small>tap to fold away</small>
            </motion.button>
          )}
          {busy && claimed.length > 0 && (
            <motion.div key="waiting" className={classes.waitRow} layout="position" {...FADE_IN}>
              ✋ {claimed.length} waiting for a parent to check
              <span className={classes.miniIcons}>
                {claimed.map((q) => (
                  <span key={q.id} data-quest-id={q.id}>
                    {q.icon}
                  </span>
                ))}
              </span>
            </motion.div>
          )}
          {quests.length > 0 && open.length + claimed.length === 0 && (
            <motion.div key="all-done" className={classes.allDone} {...FADE_IN}>
              🏆 All quests complete!
            </motion.div>
          )}
          {approved.map((q) => (
            <motion.div key={q.id} layout="position" transition={CARD_MOVE} {...FADE_IN}>
              <ApprovedQuestRow quest={q} />
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>

      <LootCard
        child={child}
        payday={payday}
        currency={currency}
        timezone={timezone}
        now={now}
        onOpen={onSavings}
        onNewJar={onNewJar}
        onEnvelope={onEnvelope}
      />

      <AnimatePresence>
        {report && (
          <MorningReport key={report.id} child={child} report={report} onClose={onReportClose} />
        )}
      </AnimatePresence>
    </section>
  );
}

/** The player card's streak (spec 005): one-size flame, coloured by the streak's length. */
function StreakFlame({ days, best }: { days: number; best: number }) {
  const tier = flameTier(days);
  return (
    <div
      className={classes.streak}
      style={{ '--tc': flameColours(tier).text } as CSSProperties}
      title={`Best ever: ${best} ${best === 1 ? 'day' : 'days'}`}
    >
      <Flame tier={tier} />
      <div className={classes.streakDays}>{days}</div>
      <div className={classes.streakCaption}>{days ? 'day streak' : 'start one today!'}</div>
    </div>
  );
}
