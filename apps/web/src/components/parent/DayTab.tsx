import { parseTimeOfDay, pointsRange, weekDates, weekdayOf, zonedTimeOf } from '@pmp/shared';
import { useState, type CSSProperties } from 'react';
import { DAY_SHORT } from '../../lib/format';
import { useServerNow } from '../../lib/server-clock';
import { sound } from '../../lib/sounds';
import { DashedButton, DayAxis, PlayerBadge, WindowBar, type ClaimDot } from '../arcade';
import { useDay, useParentUi } from './context';
import classes from './parent.module.css';

/**
 * The Day tab (spec 003): the week's day strip, a player filter, and a row per quest on
 * the shared 6am–9pm axis. Today also shows each child's status, a live now-line and the
 * claim dots; other days show the current plan.
 */
export function DayTab({ flashChoreId }: { flashChoreId: number | null }) {
  const ui = useParentUi();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<number | 'all'>('all');
  const today = useDay('today');
  const date = selected ?? today.data?.today ?? 'today';
  const day = useDay(date === today.data?.today ? 'today' : date);
  const now = useServerNow(day.data?.clockOffsetMs ?? 0);

  const plan = day.data;
  if (!plan) return null;
  const isToday = plan.date === plan.today;
  const nowMinutes = parseTimeOfDay(zonedTimeOf(now, plan.timezone));
  const childById = new Map(plan.children.map((c) => [c.id, c]));
  const quests = plan.quests.filter((q) => filter === 'all' || q.chore.childIds.includes(filter));

  return (
    <>
      <div className={classes.days}>
        {weekDates(plan.today).map((d) => (
          <button
            key={d}
            type="button"
            data-on={d === plan.date || undefined}
            data-today={d === plan.today || undefined}
            onClick={() => {
              setSelected(d);
              sound.tap();
            }}
          >
            {DAY_SHORT[weekdayOf(d)]}
            <b>{Number(d.slice(8))}</b>
          </button>
        ))}
      </div>

      <div className={classes.filter}>
        <button
          type="button"
          data-on={filter === 'all' || undefined}
          onClick={() => setFilter('all')}
        >
          All
        </button>
        {plan.children.map((c) => (
          <button
            key={c.id}
            type="button"
            data-on={filter === c.id || undefined}
            style={{ '--c': c.colour } as CSSProperties}
            onClick={() => setFilter(c.id)}
          >
            {c.avatar} {c.name}
          </button>
        ))}
        <small>{isToday ? 'today' : 'planned'}</small>
      </div>

      <DayAxis />
      {quests.map(({ chore, skipped, instances }) => {
        const range = pointsRange(chore);
        const players = chore.childIds.filter((id) => filter === 'all' || id === filter);
        // Its last player was removed (ADR 0009): kept, but nothing is scheduled.
        const unplayed = chore.childIds.length === 0;
        const dots: ClaimDot[] = instances
          .filter(
            (i) => i.claimedAt !== null && (i.status === 'claimed' || i.status === 'approved'),
          )
          .filter((i) => filter === 'all' || i.childId === filter)
          .map((i) => ({
            key: i.id,
            minutes: parseTimeOfDay(zonedTimeOf(i.claimedAt!, plan.timezone)),
            avatar: childById.get(i.childId)?.avatar ?? '🙂',
            approved: i.status === 'approved',
          }));
        return (
          <button
            key={chore.id}
            type="button"
            className={classes.quest}
            data-skipped={(isToday && skipped) || unplayed || undefined}
            data-flash={flashChoreId === chore.id || undefined}
            onClick={() => ui.openQuest(chore.id)}
          >
            <div className={classes.questHead}>
              <span className={classes.icon}>{chore.icon}</span>
              <b>{chore.title}</b>
              <span className={classes.who}>
                {players.map((id) => {
                  const child = childById.get(id);
                  if (!child) return null;
                  const status = instances.find((i) => i.childId === id)?.status;
                  return (
                    <span key={id} className={classes.status} data-status={status}>
                      <PlayerBadge avatar={child.avatar} colour={child.colour} />
                    </span>
                  );
                })}
              </span>
              <span className={classes.points}>
                {unplayed
                  ? '⏸ no players'
                  : isToday && skipped
                    ? 'SKIP'
                    : `${range.onTime}–${range.max}`}
              </span>
            </div>
            <WindowBar
              times={chore}
              nowMinutes={isToday ? nowMinutes : undefined}
              dots={isToday ? dots : []}
            />
          </button>
        );
      })}
      {quests.length === 0 && (
        <div className={classes.empty}>No quests on {DAY_SHORT[weekdayOf(plan.date)]}.</div>
      )}
      <DashedButton
        onClick={() =>
          ui.newQuest({ offerOneOff: isToday, childId: filter === 'all' ? undefined : filter })
        }
      >
        ＋ New quest{isToday ? ' · or a one-off for today' : ''}
      </DashedButton>
    </>
  );
}
