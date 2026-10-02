import { useId, type CSSProperties } from 'react';

/** A milestone line on a big jar: where it sits (0–1 of the jar) and its label. */
export interface JarMark {
  at: number;
  label: string;
  passed: boolean;
}

const PATH = 'M32 8h36v8c16 6 22 16 22 32v60c0 9-6 14-14 14H24c-8 0-14-5-14-14V48c0-16 6-26 22-32z';
const TOP = 22;
const BOTTOM = 120;
const SPAN = BOTTOM - TOP;

const COINS = Array.from({ length: 12 * 7 }, (_, i) => {
  const row = Math.floor(i / 7);
  const col = i % 7;
  return { cx: 10 + col * 14 + (row % 2) * 7, cy: BOTTOM - 4 - row * 9 };
});

/**
 * A glass jar filled with gold coins to `fill` (0–1), with the jar's emoji on the glass and
 * a lid in the child's colour (spec 004, after prototype 004-D). The coins slide to a new
 * level when `fill` changes.
 */
export function Jar({
  fill,
  emoji,
  colour,
  width = 110,
  glow = false,
  marks = [],
  className,
  style,
}: {
  fill: number;
  emoji?: string;
  colour: string;
  width?: number;
  glow?: boolean;
  marks?: JarMark[];
  className?: string;
  style?: CSSProperties;
}) {
  const clip = useId();
  const level = Math.max(0, Math.min(1, fill));
  const y = (p: number) => BOTTOM - SPAN * p;
  return (
    <svg
      viewBox="0 0 100 126"
      width={width}
      height={width * 1.26}
      className={className}
      data-jar-svg
      style={{
        overflow: 'visible',
        filter: glow ? `drop-shadow(0 0 14px ${colour})` : undefined,
        ...style,
      }}
      aria-hidden
    >
      <defs>
        <clipPath id={clip}>
          <path d={PATH} />
        </clipPath>
      </defs>
      <path d={PATH} fill="rgba(160,170,255,.10)" />
      <g clipPath={`url(#${clip})`}>
        <g
          style={{
            transform: `translateY(${(1 - level) * SPAN}px)`,
            transition: 'transform 0.45s cubic-bezier(.3,1.4,.5,1)',
          }}
        >
          <rect x="0" y={TOP} width="100" height={SPAN + 10} fill="#e8a400" />
          {COINS.map((c, i) => (
            <ellipse
              key={i}
              cx={c.cx}
              cy={c.cy}
              rx="7"
              ry="4.5"
              fill="#ffd43b"
              stroke="#d99a00"
              strokeWidth="1.2"
            />
          ))}
          <ellipse cx="50" cy={TOP} rx="48" ry="5" fill="#fff3b0" opacity=".85" />
        </g>
      </g>
      {marks.map((m) => (
        <g key={m.label} opacity={m.passed ? 0.5 : 1}>
          <line
            x1="12"
            x2="88"
            y1={y(m.at)}
            y2={y(m.at)}
            stroke="#fff"
            strokeWidth="1.4"
            strokeDasharray="4 3"
          />
          <text
            x="93"
            y={y(m.at) + 3}
            fontSize="9"
            fill="#fff"
            fontFamily="Fredoka, sans-serif"
            fontWeight="600"
          >
            {m.label}
          </text>
        </g>
      ))}
      <path d={PATH} fill="none" stroke="rgba(220,225,255,.75)" strokeWidth="3" />
      <path
        d="M20 52c0-10 3-18 10-22"
        fill="none"
        stroke="rgba(255,255,255,.55)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <rect
        x="28"
        y="2"
        width="44"
        height="10"
        rx="4"
        fill={colour}
        stroke="rgba(255,255,255,.4)"
        strokeWidth="1.5"
      />
      {emoji && (
        <>
          <circle cx="50" cy="74" r="17" fill="rgba(15,16,36,.55)" />
          <text x="50" y="82" fontSize="22" textAnchor="middle">
            {emoji}
          </text>
        </>
      )}
    </svg>
  );
}
