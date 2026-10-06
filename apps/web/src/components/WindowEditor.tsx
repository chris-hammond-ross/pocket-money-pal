import {
  DAY_PERIODS,
  editorHourLabels,
  editorSpan,
  markerToDrag,
  moveMarker,
  parseTimeOfDay,
  periodOf,
  shiftWindow,
  spanPercent,
  type ChoreTimes,
  type MarkerKey,
} from '@pmp/shared';
import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { clock12 } from '../lib/format';
import { sound } from '../lib/sounds';
import classes from './QuestEditor.module.css';

const MARKERS: { key: MarkerKey; icon: string; colour: string; label: string; below: boolean }[] = [
  { key: 'bonusBefore', icon: '⚡', colour: 'var(--pmp-bonus)', label: 'Bonus ends', below: false },
  { key: 'dueBy', icon: '🏁', colour: 'var(--pmp-due)', label: 'Due', below: true },
  { key: 'lateAfter', icon: '🥀', colour: 'var(--pmp-late)', label: 'Late after', below: false },
];

function hourLabel(hour: number): string {
  return `${((hour + 11) % 12) + 1}${hour < 12 ? 'am' : 'pm'}`;
}

/**
 * The quest editor's window bar (spec 003): three markers dragged along a bar zoomed to
 * this chore. The zoom is fixed when the sheet opens, so the bar never moves under a
 * thumb, until a time-of-day chip moves the whole window and re-zooms it. Markers snap to 15 minutes, can't pass each other, grow while dragged, and tick
 * on every snap. The rules are `moveMarker` and `editorSpan` in @pmp/shared.
 */
export function WindowEditor({
  times,
  onChange,
}: {
  times: ChoreTimes;
  onChange: (times: ChoreTimes) => void;
}) {
  const [span, setSpan] = useState(() => editorSpan(times));
  const period = periodOf(times);
  const rail = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<MarkerKey | null>(null);
  // The times and marker during a drag, for pointer moves that arrive before the next render.
  const latest = useRef(times);
  const active = useRef<MarkerKey | null>(null);

  const pct = (t: string) => spanPercent(span, parseTimeOfDay(t));
  const [b, d, l] = [pct(times.bonusBefore), pct(times.dueBy), pct(times.lateAfter)];
  const quarters = (span.end - span.start) / 15;

  const move = (e: PointerEvent) => {
    const box = rail.current?.getBoundingClientRect();
    if (!box || !active.current) return;
    const minutes = span.start + ((e.clientX - box.left) / box.width) * (span.end - span.start);
    // Markers on the same time: the drag goes to whichever one can move that way.
    const key = markerToDrag(latest.current, active.current, minutes);
    if (key !== active.current) {
      active.current = key;
      setDragging(key);
    }
    const next = moveMarker(latest.current, key, minutes, span);
    if (next[key] !== latest.current[key]) {
      latest.current = next;
      onChange(next);
      sound.tick();
    }
  };

  return (
    <>
      <div className={classes.periods}>
        {DAY_PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            data-on={p.key === period.key || undefined}
            onClick={() => {
              const next = shiftWindow(times, p.dueBy);
              setSpan(editorSpan(next));
              onChange(next);
              sound.tap();
            }}
          >
            <span>{p.icon}</span>
            {p.label}
          </button>
        ))}
      </div>
      <p className={classes.dragHint}>Drag the markers to set the times</p>
      <div className={classes.editor}>
        <div ref={rail} className={classes.rail}>
          <div style={{ left: 0, width: `${b}%`, background: 'var(--pmp-bonus)' }} />
          <div style={{ left: `${b}%`, width: `${d - b}%`, background: 'var(--pmp-due)' }} />
          <div style={{ left: `${d}%`, width: `${l - d}%`, background: 'var(--pmp-overdue)' }} />
          <div
            style={{
              left: `${l}%`,
              right: 0,
              opacity: 0.6,
              background:
                'repeating-linear-gradient(45deg, var(--pmp-late) 0 6px, var(--pmp-late-dark) 6px 12px)',
            }}
          />
        </div>
        <div className={classes.ticks} aria-hidden>
          {Array.from({ length: quarters + 1 }, (_, q) => (
            <i
              key={q}
              data-minor={q % 4 !== 0 || undefined}
              style={{ left: `${(q / quarters) * 100}%` }}
            />
          ))}
        </div>
        {MARKERS.map((m) => (
          <div
            key={m.key}
            role="slider"
            tabIndex={0}
            aria-label={m.label}
            aria-valuetext={clock12(times[m.key])}
            aria-valuemin={span.start}
            aria-valuemax={span.end}
            aria-valuenow={parseTimeOfDay(times[m.key])}
            className={classes.marker}
            data-below={m.below || undefined}
            data-dragging={dragging === m.key || undefined}
            style={{ left: `${pct(times[m.key])}%`, '--mc': m.colour } as CSSProperties}
            onPointerDown={(e) => {
              latest.current = times;
              active.current = m.key;
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragging(m.key);
              sound.tap();
            }}
            onPointerMove={(e) => {
              if (active.current) move(e);
            }}
            onPointerUp={() => {
              active.current = null;
              setDragging(null);
            }}
            onPointerCancel={() => {
              active.current = null;
              setDragging(null);
            }}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' ? 15 : e.key === 'ArrowLeft' ? -15 : 0;
              if (!step) return;
              e.preventDefault();
              const next = moveMarker(times, m.key, parseTimeOfDay(times[m.key]) + step, span);
              if (next[m.key] !== times[m.key]) {
                onChange(next);
                sound.tick();
              }
            }}
          >
            <span className={classes.time}>{clock12(times[m.key])}</span>
            <div className={classes.knob}>{m.icon}</div>
          </div>
        ))}
      </div>
      <div className={classes.hours} aria-hidden>
        {editorHourLabels(span).map((h) => (
          <span key={h} style={{ left: `${spanPercent(span, h * 60)}%` }}>
            {hourLabel(h)}
          </span>
        ))}
      </div>
      <div className={classes.legend}>
        <span>
          <i style={{ background: 'var(--pmp-bonus)' }} />
          <b>Bonus</b> if done early
        </span>
        <span>
          <i style={{ background: 'var(--pmp-due)' }} />
          <b>On time</b>
        </span>
        <span>
          <i style={{ background: 'var(--pmp-overdue)' }} />
          <b>Overdue</b>, no penalty yet
        </span>
        <span>
          <i style={{ background: 'var(--pmp-late)' }} />
          <b>Late</b>, points off
        </span>
      </div>
    </>
  );
}
