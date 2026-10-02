import confetti from 'canvas-confetti';
import { arcade } from '../theme';

const ARCADE_COLOURS = [arcade.gold, arcade.bonus, arcade.due, arcade.overdue, arcade.late];

/** A burst of confetti; `colours` defaults to the arcade palette. */
export function celebrate(options: { colours?: string[]; y?: number; count?: number } = {}) {
  void confetti({
    particleCount: options.count ?? 120,
    spread: 90,
    origin: { y: options.y ?? 0.5 },
    colors: options.colours ?? ARCADE_COLOURS,
    disableForReducedMotion: true,
  });
}

/** A burst fired from the middle of an element on screen (a quest card). */
export function confettiFrom(rect: DOMRect, colours: string[], count = 90) {
  void confetti({
    particleCount: count,
    spread: 70,
    startVelocity: 35,
    origin: {
      x: (rect.left + rect.width / 2) / window.innerWidth,
      y: (rect.top + rect.height / 2) / window.innerHeight,
    },
    colors: colours,
    disableForReducedMotion: true,
  });
}
