import { Drawer } from '@mantine/core';
import {
  formatRate,
  parseTimeOfDay,
  rateCaption,
  RATE_SLIDER_MAX,
  RATE_SLIDER_MIN,
  type ChoreTimes,
} from '@pmp/shared';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import classes from './arcade.module.css';

type Tone = 'gold' | 'green' | 'ghost' | 'red';

/** A full-width chunky game button (gold by default). */
export function ArcadeButton({
  tone = 'gold',
  size,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: 'small' }) {
  return (
    <button
      type="button"
      {...props}
      data-tone={tone}
      data-size={size}
      className={[classes.button, className].filter(Boolean).join(' ')}
    />
  );
}

/** A small pixel-font section label ("PLAYERS", "LOOT"), with optional content on the right. */
export function PixelLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className={classes.label}>
      <span>{children}</span>
      {right}
    </div>
  );
}

export function DashedButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={classes.dashed} />;
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={classes.close} onClick={onClick} aria-label="Close">
      ✕
    </button>
  );
}

/** A sheet that slides up from the bottom, its top border in `colour`. */
export function Sheet({
  opened,
  onClose,
  colour,
  head,
  footer,
  children,
  short = false,
}: {
  opened: boolean;
  onClose: () => void;
  colour?: string;
  head: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  short?: boolean;
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="bottom"
      size={short ? 'auto' : 'calc(100dvh - 44px)'}
      withCloseButton={false}
      padding={0}
      classNames={{ content: classes.sheetContent, body: classes.sheetBody }}
      styles={{ content: { '--sheet-colour': colour } as CSSProperties }}
      overlayProps={{ backgroundOpacity: 0.6, color: '#050514' }}
      transitionProps={{ transition: 'slide-up', duration: 280 }}
    >
      <div className={classes.sheetHead}>{head}</div>
      <div className={classes.sheetScroll}>{children}</div>
      {footer && <div className={classes.sheetFoot}>{footer}</div>}
    </Drawer>
  );
}

/**
 * LOOT RATE: "1 point = 5p", a 1p–20p slider and "20 points = £1.00". `onChange` follows the
 * thumb; `onCommit` fires when it's let go (the Players tab saves then).
 */
export function RateSlider({
  value,
  currency,
  onChange,
  onCommit,
}: {
  value: number;
  currency: string;
  onChange: (centsPerPoint: number) => void;
  onCommit?: () => void;
}) {
  return (
    <div className={classes.rate}>
      <div className={classes.rateValue}>
        <span>1 point =</span>
        <b>{formatRate(value, currency)}</b>
      </div>
      <input
        type="range"
        min={RATE_SLIDER_MIN}
        max={RATE_SLIDER_MAX}
        value={value}
        aria-label="What a point is worth"
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <small>{rateCaption(value, currency)}</small>
    </div>
  );
}

export function PlayerBadge({ avatar, colour }: { avatar: string; colour: string }) {
  return (
    <span className={classes.badge} style={{ '--c': colour } as CSSProperties}>
      {avatar}
    </span>
  );
}

const AXIS_START = 6 * 60;
const AXIS_END = 21 * 60;
const AXIS_HOURS = [6, 9, 12, 15, 18, 21];

/** Position of a time of day (minutes) on the 6am–9pm axis, as a clamped percentage. */
function axisPercent(minutes: number): number {
  return Math.max(0, Math.min(100, ((minutes - AXIS_START) / (AXIS_END - AXIS_START)) * 100));
}

function hourLabel(hour: number): string {
  return `${((hour + 11) % 12) + 1}${hour < 12 ? 'am' : 'pm'}`;
}

/** The shared 6am … 9pm time axis above a list of window bars. */
export function DayAxis() {
  return (
    <div className={classes.axis}>
      {AXIS_HOURS.map((h) => (
        <span key={h} style={{ left: `${axisPercent(h * 60)}%` }}>
          {hourLabel(h)}
        </span>
      ))}
    </div>
  );
}

/** A child's claim on a window bar: their avatar at the claim time (spec 003). */
export interface ClaimDot {
  key: number | string;
  minutes: number;
  avatar: string;
  approved: boolean;
}

/**
 * A chore's window on the day axis: green until `bonus_before`, amber until `due_by`,
 * orange until `late_after`, then hatched red. `nowMinutes` draws the white now-line, and
 * `dots` each claim (gold ring while waiting, green once approved).
 */
export function WindowBar({
  times,
  nowMinutes,
  dots = [],
}: {
  times: ChoreTimes;
  nowMinutes?: number;
  dots?: ClaimDot[];
}) {
  const [b, d, l] = [times.bonusBefore, times.dueBy, times.lateAfter].map((t) =>
    axisPercent(parseTimeOfDay(t)),
  ) as [number, number, number];
  return (
    <div className={classes.bar}>
      <div className={`${classes.seg} ${classes.segBonus}`} style={{ left: 0, width: `${b}%` }} />
      <div
        className={`${classes.seg} ${classes.segDue}`}
        style={{ left: `${b}%`, width: `${d - b}%` }}
      />
      <div
        className={`${classes.seg} ${classes.segOverdue}`}
        style={{ left: `${d}%`, width: `${l - d}%` }}
      />
      <div className={`${classes.seg} ${classes.segLate}`} style={{ left: `${l}%`, right: 0 }} />
      {dots.map((dot) => (
        <div
          key={dot.key}
          className={classes.dot}
          data-approved={dot.approved || undefined}
          style={{ left: `${axisPercent(dot.minutes)}%` }}
        >
          {dot.avatar}
        </div>
      ))}
      {nowMinutes !== undefined && (
        <div className={classes.now} style={{ left: `${axisPercent(nowMinutes)}%` }} />
      )}
    </div>
  );
}

/** A stretch of a surprise's day on its bar (spec 006), in minutes since midnight. */
export interface SurpriseSpan {
  from: number;
  to: number;
  /** Planned (faint), live (purple), up to the grab (purple), or expired (hatched grey). */
  tone: 'planned' | 'live' | 'grabbed' | 'expired';
}

/**
 * A surprise quest's row bar on the 6am–9pm axis (spec 006, "SURPRISES TODAY"): its span,
 * a marker (⚡ at a set time, ⏳ while queued), the takers' dots and the now-line.
 */
export function SurpriseBar({
  span,
  marker,
  nowMinutes,
  dots = [],
}: {
  span?: SurpriseSpan;
  marker?: { minutes: number; icon: string };
  nowMinutes?: number;
  dots?: ClaimDot[];
}) {
  return (
    <div className={classes.bar}>
      {span && (
        <div
          className={`${classes.seg} ${classes.segSurprise}`}
          data-tone={span.tone}
          style={{
            left: `${axisPercent(span.from)}%`,
            // At least a sliver, so a 1-minute surprise still shows.
            width: `max(4px, ${axisPercent(span.to) - axisPercent(span.from)}%)`,
          }}
        />
      )}
      {marker && (
        <div className={classes.marker} style={{ left: `${axisPercent(marker.minutes)}%` }}>
          {marker.icon}
        </div>
      )}
      {dots.map((dot, i) => (
        <div
          key={dot.key}
          className={classes.dot}
          data-approved={dot.approved || undefined}
          // Takers grabbed at the same moment: side by side, not on top of each other.
          style={{ left: `calc(${axisPercent(dot.minutes)}% + ${i * 14}px)` }}
        >
          {dot.avatar}
        </div>
      ))}
      {nowMinutes !== undefined && (
        <div className={classes.now} style={{ left: `${axisPercent(nowMinutes)}%` }} />
      )}
    </div>
  );
}
