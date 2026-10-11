import type { CSSProperties } from 'react';
import classes from './money.module.css';

/**
 * The piggy bank (ADR 0019): Twemoji's 🐖 with a 🪙 just behind its back, as if
 * going in (both unmodified, credited in `public/parent/CREDITS.md`). It has no price, so
 * unlike a jar it never fills or glows full.
 */
export function Piggy({
  width = 140,
  className,
  style,
}: {
  width?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`${classes.piggy} ${className ?? ''}`}
      style={{ width, height: width * 0.92, ...style }}
      aria-hidden
    >
      <img src="/coin.svg" alt="" className={classes.piggyCoin} draggable={false} />
      <img src="/pig-body.svg" alt="" className={classes.piggyPig} draggable={false} />
    </div>
  );
}
