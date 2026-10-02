import {
  orderKioskQuests,
  type Envelope,
  type KioskChild,
  type KioskQuest,
  type PaydayInfo,
} from '@pmp/shared';
import { AnimatePresence, motion, type Transition } from 'framer-motion';
import type { CSSProperties } from 'react';
import classes from './kiosk.module.css';
import { LootCard } from './money/LootCard';
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

  return (
    <section className={classes.player} style={{ '--c': child.colour } as CSSProperties}>
      <div className={classes.hud}>
        <div className={classes.avatar}>{child.avatar}</div>
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
          {/* Streaks arrive in Phase 5; until then the server always sends 0. */}
          <div className={classes.streak}>
            <span className={classes.flame}>🔥</span>
            {child.streakDays} day streak
          </div>
        </div>
      </div>

      <NextUp quest={open[0]} hadQuests={quests.length > 0} now={now} />

      {/* Claimed quests are done as far as the child is concerned: only open ones are left. */}
      <div className={classes.sectionTitle}>QUESTS · {open.length} LEFT</div>
      {/*
       * One list, so a card keeps its key as it goes open → claimed → approved: `layout`
       * slides it to its new place, and the inner key on the status pops in the new look.
       */}
      <motion.div className={classes.quests} layoutScroll>
        <AnimatePresence initial={false}>
          {[...open, ...claimed].map((q) => (
            <motion.div key={q.id} layout="position" transition={CARD_MOVE}>
              <motion.div
                key={q.status}
                initial={{ scale: 0.92, opacity: 0.4 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={CARD_POP}
              >
                {q.status === 'open' ? (
                  <OpenQuestCard quest={q} now={now} dayStart={dayStart} onClaim={onClaim} />
                ) : (
                  <ClaimedQuestCard quest={q} timezone={timezone} />
                )}
              </motion.div>
            </motion.div>
          ))}
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
    </section>
  );
}
