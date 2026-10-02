/**
 * Things that fly across the kiosk: coins from "to sort" into a jar (and back), and the
 * stars from an approved quest into the payday box (spec 004). Plain DOM elements animated
 * with the Web Animations API, so a stream of coins doesn't re-render React.
 */

const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

export interface FlyOptions {
  /** What flies: "🪙" by default. */
  text?: string;
  count?: number;
  /** Between one token and the next. */
  staggerMs?: number;
  durationMs?: number;
  size?: number;
  /** Each token landing (for a clink). */
  onLand?: (index: number) => void;
}

/** Tokens arc from one rectangle to another. Resolves when the last one lands. */
export function flyTokens(from: DOMRect, to: DOMRect, opts: FlyOptions = {}): Promise<void> {
  const { text = '🪙', count = 1, staggerMs = 70, durationMs = 600, size = 30 } = opts;
  const a = centre(from);
  const b = centre(to);
  const lift = Math.min(160, Math.abs(b.x - a.x) * 0.3 + 60);
  return new Promise((resolve) => {
    let landed = 0;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const el = document.createElement('div');
        el.textContent = text;
        Object.assign(el.style, {
          position: 'fixed',
          left: `${a.x}px`,
          top: `${a.y}px`,
          fontSize: `${size}px`,
          lineHeight: '1',
          pointerEvents: 'none',
          zIndex: '400',
          translate: '-50% -50%',
          filter: 'drop-shadow(0 3px 4px rgba(0,0,0,.5))',
        });
        document.body.appendChild(el);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const anim = el.animate(
          [
            { transform: 'translate(0, 0) scale(0.7)', opacity: 0.4 },
            {
              transform: `translate(${dx * 0.5}px, ${dy * 0.5 - lift}px) scale(1.15)`,
              opacity: 1,
              offset: 0.5,
            },
            { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0.9 },
          ],
          { duration: durationMs, easing: 'cubic-bezier(.4,0,.6,1)' },
        );
        anim.onfinish = () => {
          el.remove();
          opts.onLand?.(i);
          if (++landed === count) resolve();
        };
      }, i * staggerMs);
    }
    if (count <= 0) resolve();
  });
}

/** An element's rectangle, by a CSS selector, if it's on screen. */
export function rectOf(selector: string): DOMRect | null {
  const el = document.querySelector(selector);
  return el ? el.getBoundingClientRect() : null;
}
