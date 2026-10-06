/**
 * The quest editor (spec 003): icon and title, players and TOGETHER, the draggable window
 * bar, loot counters with the earnings line, and days (or "one-off, today only").
 *
 * It edits a `SetupChore`, whose players are string keys, so first-run setup (drafts with
 * client keys) and the phone (chore ids as strings) share it. The phone adds its TODAY
 * section as `today`, and its `clock` for a new quest's STARTS choice (today, or next time
 * when its bonus time is nearly over). Saving is the caller's job; the shared schema
 * checks it first.
 */
import { Switch } from '@mantine/core';
import {
  CHORE_LIBRARY,
  WEEKDAYS,
  formatMoney,
  choreRunsOn,
  pointsRange,
  setupChoreSchema,
  startsNextTime,
  type SetupChore,
} from '@pmp/shared';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { DAY_SHORT, formatDate } from '../lib/format';
import { sound } from '../lib/sounds';
import { ArcadeButton, CloseButton, PixelLabel, Sheet } from './arcade';
import classes from './QuestEditor.module.css';
import { WindowEditor } from './WindowEditor';

/** Someone who can be given the quest: a setup player, or a child on the phone. */
export interface EditorPlayer {
  key: string;
  name: string;
  avatar: string;
  colour: string;
}

// The star first: it's a new quest's icon, so it reads as chosen and changeable.
const ICONS = [
  ...new Set(['⭐', ...CHORE_LIBRARY.map((c) => c.icon), '🧺', '🛁', '🐶', '🌱', '🚲', '📦']),
];

const LOOT = [
  { key: 'basePoints', label: '✔ Done', step: 5 },
  { key: 'earlyBonus', label: '⚡ Early bird', step: 1 },
  { key: 'unpromptedBonus', label: '🦸 Not asked', step: 1 },
  { key: 'latePenalty', label: '🥀 Late', step: 1 },
] as const;

export function QuestEditor({
  opened,
  chore,
  isNew,
  players,
  centsPerPoint,
  currency,
  colour,
  today,
  todayDate,
  clock,
  saving = false,
  error,
  onSave,
  onDelete,
  onClose,
}: {
  opened: boolean;
  chore: SetupChore;
  isNew: boolean;
  players: EditorPlayer[];
  centsPerPoint: number;
  currency: string;
  /** The sheet's top border: the chore's stage colour today. */
  colour?: string;
  /** The phone's TODAY section (spec 003), for a chore that runs today. */
  today?: ReactNode;
  /** Today's date, to say which day a one-off for a later day is on. */
  todayDate?: string;
  /** The family's clock, for a new quest that runs today: does it start today or next time? */
  clock?: { now: number; timezone: string };
  saving?: boolean;
  /** Why the last save failed, if it did. */
  error?: string | null;
  onSave: (chore: SetupChore, start: { nextTime: boolean }) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [c, setC] = useState(chore);
  const [showIcons, setShowIcons] = useState(isNew && !chore.title);
  const [armed, setArmed] = useState(false);
  // Today or next time, once the parent picks; until then it follows the bonus time.
  const [startPick, setStartPick] = useState<'today' | 'next' | null>(null);

  const parsed = setupChoreSchema.safeParse(c);
  const problem = parsed.success
    ? null
    : (parsed.error.issues.find((i) => i.path[0] !== 'title')?.message ?? null);
  const range = pointsRange(c);
  const money = (points: number) => formatMoney(points * centsPerPoint, currency);
  const asksStart =
    isNew && !!clock && !!todayDate && c.oneOffDate === null && choreRunsOn(c, todayDate);
  const lateToday = asksStart && startsNextTime(c, todayDate, clock.now, clock.timezone);
  const start = startPick ?? (lateToday ? 'next' : 'today');

  const togglePlayer = (key: string) => {
    const childKeys = c.childKeys.includes(key)
      ? c.childKeys.filter((k) => k !== key)
      : [...c.childKeys, key];
    setC({ ...c, childKeys, together: c.together && childKeys.length >= 2 });
    sound.tap();
  };

  return (
    <Sheet
      opened={opened}
      onClose={onClose}
      colour={colour}
      head={
        <>
          <button
            type="button"
            className={classes.iconButton}
            onClick={() => setShowIcons(!showIcons)}
            aria-label="Choose an icon"
          >
            {c.icon}
          </button>
          <input
            className={classes.title}
            placeholder="Quest name"
            // A new quest starts at its name (Mantine's focus trap looks for this).
            data-autofocus={isNew || undefined}
            value={c.title}
            maxLength={40}
            onChange={(e) => setC({ ...c, title: e.target.value })}
          />
          <CloseButton onClick={onClose} />
        </>
      }
      footer={
        <>
          {!c.title.trim() && <p className={classes.hint}>Give the quest a name first</p>}
          {problem && c.title.trim() && <p className={classes.problem}>{problem}</p>}
          {error && <p className={classes.problem}>{error}</p>}
          <ArcadeButton
            disabled={!parsed.success || saving}
            onClick={() => {
              if (!parsed.success) return;
              onSave({ ...c, title: c.title.trim() }, { nextTime: asksStart && start === 'next' });
              sound.pop();
            }}
          >
            {isNew ? '＋ Add quest' : '💾 Save quest'}
          </ArcadeButton>
        </>
      }
    >
      {showIcons && (
        <div className={classes.icons}>
          {ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              data-on={icon === c.icon || undefined}
              onClick={() => {
                setC({ ...c, icon });
                sound.tap();
              }}
            >
              {icon}
            </button>
          ))}
        </div>
      )}

      <PixelLabel>PLAYERS</PixelLabel>
      <div className={classes.players}>
        {players.map((p) => (
          <button
            key={p.key}
            type="button"
            data-on={c.childKeys.includes(p.key) || undefined}
            style={{ '--c': p.colour } as CSSProperties}
            onClick={() => togglePlayer(p.key)}
          >
            <span>{p.avatar}</span>
            {p.name}
          </button>
        ))}
      </div>
      {c.childKeys.length > 1 && (
        <Switch
          className={classes.together}
          size="sm"
          color="gold"
          label="👫 TOGETHER?"
          checked={c.together}
          onChange={(e) => setC({ ...c, together: e.currentTarget.checked })}
        />
      )}

      <PixelLabel>QUEST WINDOW</PixelLabel>
      <WindowEditor times={c} onChange={(times) => setC((prev) => ({ ...prev, ...times }))} />

      <PixelLabel>LOOT</PixelLabel>
      <div className={classes.loot}>
        {LOOT.map(({ key, label, step }) => (
          <div key={key} data-negative={key === 'latePenalty' || undefined}>
            <small>{label}</small>
            <div className={classes.counter}>
              <button
                type="button"
                aria-label={`Less ${label}`}
                disabled={c[key] === 0}
                onClick={() => {
                  setC({ ...c, [key]: Math.max(0, c[key] - step) });
                  sound.tap();
                }}
              >
                −
              </button>
              <b>
                {key === 'latePenalty' ? '−' : '+'}
                {c[key]}
              </b>
              <button
                type="button"
                aria-label={`More ${label}`}
                onClick={() => {
                  setC({ ...c, [key]: c[key] + step });
                  sound.coin();
                }}
              >
                +
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className={classes.earn}>
        🪙 On time <b>{range.onTime}</b> ({money(range.onTime)}) · max <b>{range.max}</b> (
        {money(range.max)}) · late <b>{range.late}</b>
      </div>

      {c.oneOffDate !== null ? (
        <PixelLabel>
          <span className={classes.oneOff}>
            ONE-OFF ·{' '}
            {!todayDate || c.oneOffDate === todayDate
              ? 'TODAY ONLY'
              : `${formatDate(c.oneOffDate).toUpperCase()} ONLY`}
          </span>
        </PixelLabel>
      ) : (
        <>
          <PixelLabel>DAYS</PixelLabel>
          <div className={classes.days}>
            {WEEKDAYS.map((d) => (
              <button
                key={d}
                type="button"
                data-on={c.days.includes(d) || undefined}
                onClick={() => {
                  const days = c.days.includes(d) ? c.days.filter((x) => x !== d) : [...c.days, d];
                  setC({ ...c, days: WEEKDAYS.filter((x) => days.includes(x)) });
                  sound.tap();
                }}
              >
                {DAY_SHORT[d].slice(0, 2)}
              </button>
            ))}
          </div>
        </>
      )}

      {asksStart && (
        <>
          <PixelLabel>STARTS</PixelLabel>
          <div className={classes.start}>
            {(
              [
                ['today', '▶️', 'Today'],
                ['next', '⏭️', 'Next time'],
              ] as const
            ).map(([key, icon, label]) => (
              <button
                key={key}
                type="button"
                data-on={start === key || undefined}
                onClick={() => {
                  setStartPick(key);
                  sound.tap();
                }}
              >
                <span>{icon}</span>
                {label}
              </button>
            ))}
          </div>
          {lateToday && start === 'today' && (
            <p className={classes.hint}>Today’s bonus time is nearly over, so it may start late.</p>
          )}
        </>
      )}

      {today}

      {onDelete && (
        <ArcadeButton
          tone="red"
          size="small"
          className={classes.delete}
          onClick={() => {
            if (armed) onDelete();
            else {
              setArmed(true);
              sound.sad();
            }
          }}
        >
          {armed ? 'Tap again to delete' : 'Delete quest'}
        </ArcadeButton>
      )}
    </Sheet>
  );
}
