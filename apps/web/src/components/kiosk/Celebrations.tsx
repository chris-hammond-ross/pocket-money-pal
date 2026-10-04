import {
  claimFeedback,
  daysToNextLevel,
  formatPointsChange,
  isMilestoneLevel,
  levelProgress,
  type ServerEvent,
} from '@pmp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { KioskBoard } from '../../lib/api';
import { celebrate, confettiFrom } from '../../lib/confetti';
import { useLiveEvents } from '../../lib/live-events';
import { sound } from '../../lib/sounds';
import { arcade } from '../../theme';
import classes from './kiosk.module.css';
import { flyTokens } from './money/fly';
import moneyClasses from './money/money.module.css';

/**
 * Every kiosk celebration lives here: the sounds, "+N" floats and confetti that follow a
 * change on the server (spec 001, "Interactions" and "Sounds").
 *
 * They play for **WebSocket events**, never for taps, so every open kiosk shows the same
 * thing, including the one the child tapped (ADR 0007). A tap only plays its click.
 *
 * Steps go through one queue, each holding the stage for a moment before the next. A claim
 * holds for none; approvals from a phone hold 500ms each, so a batch lands one chore at a
 * time (spec 002), and a level-up holds while its overlay shows.
 * To add one: a case in `stepsFor`, and a `data-quest-id` on whatever it animates.
 *
 * A few moments come from the kiosk's own clock instead (`playLocalMoment`): a bonus that
 * ran out unclaimed (spec 005). They join the same queue.
 */
export function KioskCelebrations() {
  const { subscribe } = useLiveEvents();
  const queryClient = useQueryClient();
  const [floats, setFloats] = useState<Float[]>([]);
  const [levelUp, setLevelUp] = useState<LevelUp | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const queue = useRef(new StepQueue());
  const nextId = useRef(0);

  const addFloat = useCallback((text: string, rect: DOMRect) => {
    const id = ++nextId.current;
    setFloats((all) => [...all, { id, text, x: rect.right - 60, y: rect.top + rect.height / 2 }]);
  }, []);

  useEffect(() => {
    // The board as it was when the event arrived: the refetch it triggers comes later.
    const childOf = (childId: number) =>
      queryClient.getQueryData<KioskBoard>(['kiosk-today'])?.children.find((c) => c.id === childId);
    const colourOf = (childId: number) => childOf(childId)?.colour ?? arcade.gold;
    const showLevelUp = (childId: number, xp: number) => {
      const child = childOf(childId);
      if (!child) return;
      const progress = levelProgress(xp);
      const id = ++nextId.current;
      setLevelUp({
        id,
        name: child.name,
        avatar: child.avatar,
        colour: child.colour,
        from: progress.level - 1,
        level: progress.level,
        xp,
        xpToNext: progress.xpToNext,
        days: daysToNextLevel(progress.xpToNext, child.xpPerDay),
      });
      setTimeout(() => setLevelUp((l) => (l?.id === id ? null : l)), LEVEL_UP_MS);
    };
    const showBanner = (lines: string[], colour: string) => {
      setBanner({ lines, colour });
      setTimeout(() => setBanner(null), BANNER_MS);
    };
    const jarOf = (childId: number, goalId: number) =>
      childOf(childId)?.jars.find((j) => j.id === goalId);
    const ctx = { colourOf, addFloat, showLevelUp, showBanner, jarOf };
    const unsubscribe = subscribe((event) => {
      for (const step of stepsFor(event, ctx)) queue.current.push(step);
    });
    const local = (moment: LocalMoment) => {
      for (const step of localSteps(moment, ctx)) queue.current.push(step);
    };
    localListeners.add(local);
    return () => {
      unsubscribe();
      localListeners.delete(local);
    };
  }, [subscribe, queryClient, addFloat]);

  return (
    <>
      <AnimatePresence>
        {levelUp && (
          <LevelUpMoment key={levelUp.id} levelUp={levelUp} onClose={() => setLevelUp(null)} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {banner && (
          <motion.div
            key="banner"
            className={moneyClasses.bigBanner}
            style={{ '--c': banner.colour } as CSSProperties}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 15 }}
          >
            {banner.lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <div className={classes.floatLayer} aria-hidden>
        <AnimatePresence>
          {floats.map((f) => (
            <motion.div
              key={f.id}
              className={classes.float}
              style={{ left: f.x, top: f.y }}
              initial={{ opacity: 0, y: 0, scale: 0.6 }}
              animate={{ opacity: [0, 1, 1, 0], y: -130, scale: 1.4 }}
              transition={{ duration: 1.4, ease: 'easeOut', times: [0, 0.12, 0.7, 1] }}
              onAnimationComplete={() => setFloats((all) => all.filter((x) => x.id !== f.id))}
            >
              {f.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}

/** How long the level-up moment shows (spec 005: about 4 seconds), and holds the queue. */
const LEVEL_UP_MS = 4200;
/** When the old level number flips over to the new one. */
const LEVEL_FLIP_MS = 900;
/** How long a big banner ("💥 SMASH! 💥") shows. */
const BANNER_MS = 2400;
/** Approvals in a batch play this far apart (spec 002). */
const APPROVAL_GAP_MS = 500;

interface LevelUp {
  id: number;
  name: string;
  avatar: string;
  colour: string;
  /** The level before, which flips over to `level`. */
  from: number;
  level: number;
  /** All-time XP. */
  xp: number;
  xpToNext: number;
  /** About how many days to the next level, or null with no history yet. */
  days: number | null;
}

/** A moment the kiosk's own clock starts, not a server event (spec 005). */
export type LocalMoment = { type: 'bonus.gone'; instanceId: number; points: number };

const localListeners = new Set<(moment: LocalMoment) => void>();

/** Plays a clock-driven moment through the celebration queue. */
export function playLocalMoment(moment: LocalMoment): void {
  localListeners.forEach((listener) => listener(moment));
}

/**
 * The level-up moment (spec 005): the avatar and name, "LEVEL UP!", the old number flipping
 * over to the new one, all-time XP and the next level, and a gold pill every 5th level.
 * The fanfare and confetti play from its step; a tap closes it.
 */
function LevelUpMoment({ levelUp, onClose }: { levelUp: LevelUp; onClose: () => void }) {
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setFlipped(true);
      sound.flip();
    }, LEVEL_FLIP_MS);
    return () => clearTimeout(timer);
  }, []);
  const days =
    levelUp.days === null
      ? null
      : levelUp.days === 1
        ? 'about a day'
        : `about ${levelUp.days} days`;
  return (
    <motion.div
      className={classes.levelUp}
      style={{ '--c': levelUp.colour } as CSSProperties}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      aria-live="polite"
    >
      <div className={classes.levelUpAvatar}>{levelUp.avatar}</div>
      <div className={classes.levelUpName}>{levelUp.name.toUpperCase()}</div>
      <motion.h2
        initial={{ scale: 0.5 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 380, damping: 12 }}
      >
        LEVEL UP!
      </motion.h2>
      <div className={classes.levelUpNumber}>
        <motion.span
          key={flipped ? 'new' : 'old'}
          initial={flipped ? { rotateX: 90 } : false}
          animate={{ rotateX: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          {flipped ? levelUp.level : levelUp.from}
        </motion.span>
      </div>
      <p>
        <b>{levelUp.xp.toLocaleString()} XP</b> all-time · level {levelUp.level + 1} in{' '}
        <b>{levelUp.xpToNext.toLocaleString()} XP</b>
        {days && ` (${days})`}
      </p>
      {isMilestoneLevel(levelUp.level) && (
        <motion.div
          className={classes.levelUpPill}
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: LEVEL_FLIP_MS / 1000 + 0.3, type: 'spring', stiffness: 400 }}
        >
          ⭐ Level {levelUp.level}: a milestone!
        </motion.div>
      )}
    </motion.div>
  );
}

interface Banner {
  lines: string[];
  colour: string;
}

interface Float {
  id: number;
  text: string;
  x: number;
  y: number;
}

interface Step {
  play: () => void;
  /** How long the stage is held before the next step plays. */
  holdMs: number;
}

interface StepContext {
  colourOf: (childId: number) => string;
  addFloat: (text: string, rect: DOMRect) => void;
  showLevelUp: (childId: number, xp: number) => void;
  showBanner: (lines: string[], colour: string) => void;
  jarOf: (childId: number, goalId: number) => { name: string; emoji: string } | undefined;
}

/** Where the quest's card is on screen right now, if this kiosk shows it. */
function questRect(instanceId: number): DOMRect | null {
  const el = document.querySelector(`[data-quest-id="${instanceId}"]`);
  return el ? el.getBoundingClientRect() : null;
}

/** What an event plays. Events that don't celebrate anything give no steps. */
function stepsFor(event: ServerEvent, ctx: StepContext): Step[] {
  switch (event.type) {
    case 'instance.claimed': {
      const { claim } = event;
      // Measure now, while the card is still where the child tapped it.
      const rect = questRect(claim.instanceId);
      const feedback = claimFeedback(claim.stage);
      return [
        {
          holdMs: 0,
          play: () => {
            sound[feedback.sound]();
            if (!rect) return;
            ctx.addFloat(`+${claim.points.total}`, rect);
            if (feedback.confetti) {
              confettiFrom(rect, [ctx.colourOf(claim.childId), arcade.gold, '#ffffff']);
            }
          },
        },
      ];
    }
    case 'instance.approved': {
      const { approval } = event;
      const before = levelProgress(approval.xpBefore).level;
      const after = levelProgress(approval.xpAfter).level;
      const steps: Step[] = [
        {
          holdMs: APPROVAL_GAP_MS,
          play: () => {
            sound.coin();
            // Measured now, not when the event came: earlier steps may have moved the card.
            const rect = questRect(approval.instanceId);
            if (!rect) return;
            ctx.addFloat(`+${approval.points.total} ⭐`, rect);
            // The stars fly on into the payday box (spec 004). No money moves yet.
            const box = document.querySelector(`[data-payday-box="${approval.childId}"]`);
            if (box && approval.points.total > 0) {
              void flyTokens(rect, box.getBoundingClientRect(), {
                text: '⭐',
                count: Math.min(5, Math.max(1, Math.round(approval.points.total / 4))),
                durationMs: 900,
                staggerMs: 110,
              });
            }
          },
        },
      ];
      if (after > before) {
        steps.push({
          holdMs: LEVEL_UP_MS,
          play: () => {
            sound.fanfare();
            celebrate({ colours: [ctx.colourOf(approval.childId), arcade.gold], count: 220 });
            ctx.showLevelUp(approval.childId, approval.xpAfter);
          },
        });
      }
      return steps;
    }
    case 'instance.sent_back':
      return [{ holdMs: 0, play: () => sound.sad() }];
    case 'envelope.created':
      // A gift arrived (spec 004): a paper whoosh and a chime; the tag wiggles on the card.
      return [
        {
          holdMs: 400,
          play: () => {
            sound.whoosh();
            setTimeout(() => sound.chime(), 250);
          },
        },
      ];
    case 'goal.smashed': {
      // Smash! (spec 004): glass, then a fanfare and confetti, on every kiosk.
      const jar = ctx.jarOf(event.childId, event.goalId);
      const colour = ctx.colourOf(event.childId);
      return [
        {
          holdMs: BANNER_MS,
          play: () => {
            sound.smash();
            setTimeout(() => sound.fanfare(), 350);
            celebrate({ colours: [colour, arcade.gold, '#ffffff'], count: 200 });
            ctx.showBanner(
              ['💥 SMASH! 💥', ...(jar ? [`${jar.emoji} ${jar.name.toUpperCase()}`] : [])],
              colour,
            );
          },
        },
      ];
    }
    case 'child.adjusted': {
      // Bonus points from a phone (ADR 0009): a coin and "+10 ⭐" over the child's points,
      // or the sad tone and "−5". Bonuses aren't XP, so there's never a level-up.
      const { adjustment } = event;
      return [
        {
          holdMs: APPROVAL_GAP_MS,
          play: () => {
            if (adjustment.points > 0) sound.coin();
            else sound.sad();
            const el = document.querySelector(`[data-child-points="${adjustment.childId}"]`);
            if (!el) return;
            const text = formatPointsChange(adjustment.points);
            ctx.addFloat(adjustment.points > 0 ? `${text} ⭐` : text, el.getBoundingClientRect());
          },
        },
      ];
    }
    default:
      return [];
  }
}

/** What a clock-driven moment plays. */
function localSteps(moment: LocalMoment, ctx: StepContext): Step[] {
  switch (moment.type) {
    case 'bonus.gone':
      // The bonus ran out unclaimed (spec 005): a grey flash, "−5 bonus", a soft bloop.
      return [
        {
          holdMs: 0,
          play: () => {
            sound.bloop();
            const el = document.querySelector(`[data-quest-id="${moment.instanceId}"]`);
            if (!el) return;
            el.animate(
              [
                { filter: 'grayscale(1) brightness(0.6)', transform: 'scale(0.97)' },
                { filter: 'none', transform: 'none' },
              ],
              { duration: 1200, easing: 'ease-out' },
            );
            ctx.addFloat(`−${moment.points} bonus`, el.getBoundingClientRect());
          },
        },
      ];
  }
}

/** Plays steps one after another, holding each for its `holdMs`. */
class StepQueue {
  private steps: Step[] = [];
  private running = false;

  push(step: Step): void {
    this.steps.push(step);
    if (!this.running) this.next();
  }

  private next(): void {
    const step = this.steps.shift();
    if (!step) {
      this.running = false;
      return;
    }
    this.running = true;
    try {
      step.play();
    } finally {
      if (step.holdMs > 0) setTimeout(() => this.next(), step.holdMs);
      else this.next();
    }
  }
}
