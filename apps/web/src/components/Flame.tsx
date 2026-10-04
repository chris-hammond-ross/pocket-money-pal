import type { CSSProperties } from 'react';
import classes from './Flame.module.css';

/**
 * The streak flame's colours (spec 005, ADR 0012), by `flameTier()`: the outer flame, the
 * inner flame, and the colour for the day count and confetti. The top tier (rainbow) also
 * cycles its hue in CSS.
 */
export const FLAME_COLOURS: readonly { outer: string; inner: string; text: string }[] = [
  { outer: '#4a4d7a', inner: '#6b6fa8', text: '#8f93c7' }, // no streak
  { outer: '#ff6b00', inner: '#ffd43b', text: '#ffa94d' }, // orange
  { outer: '#fcc419', inner: '#fff9db', text: '#ffe066' }, // yellow
  { outer: '#dee2e6', inner: '#ffffff', text: '#ffffff' }, // white
  { outer: '#228be6', inner: '#a5d8ff', text: '#74c0fc' }, // blue
  { outer: '#2f9e44', inner: '#b2f2bb', text: '#8ce99a' }, // green
  { outer: '#9c36b5', inner: '#eebefa', text: '#e599f7' }, // purple
  { outer: '#f03e3e', inner: '#ffd43b', text: '#ff8787' }, // rainbow (hue cycles)
];

export function flameColours(tier: number) {
  return FLAME_COLOURS[Math.min(Math.max(tier, 0), FLAME_COLOURS.length - 1)]!;
}

/**
 * The streak flame: a two-tone SVG drawing (the 🔥 emoji's colour can't be changed), one
 * size at every streak length, flickering unless the streak is 0.
 */
export function Flame({
  tier,
  className,
  style,
}: {
  tier: number;
  className?: string;
  style?: CSSProperties;
}) {
  const c = flameColours(tier);
  return (
    <span
      className={`${classes.flame} ${className ?? ''}`}
      data-tier={tier}
      style={{ '--f1': c.outer, '--f2': c.inner, '--glow': c.text, ...style } as CSSProperties}
      aria-hidden
    >
      <svg viewBox="0 0 64 80">
        <path
          fill="var(--f1)"
          d="M32 2C36 18 56 28 56 50a24 24 0 0 1-48 0c0-14 9-20 12-32 3 7 5 11 8 13 2-10 1-19 4-29z"
        />
        <path fill="var(--f2)" d="M32 36c3 9 13 13 13 25a13 13 0 0 1-26 0c0-9 9-13 13-25z" />
      </svg>
    </span>
  );
}
