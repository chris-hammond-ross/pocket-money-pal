import { claimFeedback, formatPointsChange, levelProgress, type ServerEvent } from '@pmp/shared';
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
    const showLevelUp = (childId: number, level: number) => {
      const child = childOf(childId);
      if (!child) return;
      setLevelUp({ name: child.name, avatar: child.avatar, colour: child.colour, level });
      setTimeout(() => setLevelUp(null), LEVEL_UP_MS);
    };
    const showBanner = (lines: string[], colour: string) => {
      setBanner({ lines, colour });
      setTimeout(() => setBanner(null), BANNER_MS);
    };
    const jarOf = (childId: number, goalId: number) =>
      childOf(childId)?.jars.find((j) => j.id === goalId);
    return subscribe((event) => {
      for (const step of stepsFor(event, { colourOf, addFloat, showLevelUp, showBanner, jarOf })) {
        queue.current.push(step);
      }
    });
  }, [subscribe, queryClient, addFloat]);

  return (
    <>
      <AnimatePresence>
        {levelUp && (
          <motion.div
            key="level-up"
            className={classes.levelUp}
            style={{ '--c': levelUp.colour } as CSSProperties}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 18 }}
            aria-live="polite"
          >
            <div className={classes.levelUpAvatar}>{levelUp.avatar}</div>
            <h2>LEVEL UP!</h2>
            <p>
              {levelUp.name} is level {levelUp.level}
            </p>
          </motion.div>
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

/** How long the level-up overlay shows, and holds the queue. */
const LEVEL_UP_MS = 2600;
/** How long a big banner ("💥 SMASH! 💥") shows. */
const BANNER_MS = 2400;
/** Approvals in a batch play this far apart (spec 002). */
const APPROVAL_GAP_MS = 500;

interface LevelUp {
  name: string;
  avatar: string;
  colour: string;
  level: number;
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
  showLevelUp: (childId: number, level: number) => void;
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
            confettiFrom(new DOMRect(innerWidth / 2 - 50, innerHeight / 2 - 50, 100, 100), [
              ctx.colourOf(approval.childId),
              arcade.gold,
              '#ffffff',
            ]);
            ctx.showLevelUp(approval.childId, after);
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
