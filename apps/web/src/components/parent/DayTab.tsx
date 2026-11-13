import { parseTimeOfDay, pointsRange, weekDates, weekdayOf, zonedTimeOf } from '@pmp/shared';
import { useState, type CSSProperties } from 'react';
import { DAY_SHORT } from '../../lib/format';
import { useFamilyPc } from '../../lib/offline';
import { usePendingChores, usePlanDay } from '../../lib/outbox';
import { useServerNow } from '../../lib/server-clock';
import { sound } from '../../lib/sounds';
import { DashedButton, DayAxis, PlayerBadge, WindowBar, type ClaimDot } from '../arcade';
import { useParentUi } from './context';
import holiday from './holiday.module.css';
import outbox from './outbox.module.css';
import classes from './parent.module.css';
import { SurpriseButton, SurprisesToday } from './Surprises';

/**
 * The Day tab (spec 003): the week's day strip, a player filter, and a row per quest on
 * the shared 6am–9pm axis. Today also shows each child's status, a live now-line and the
 * claim dots; other days show the current plan. Today also has its surprises (spec 006):
 * their rows above the quests, and the "⚡ Surprise quest" button at the bottom. With the
 * family PC off, it's drawn on the phone with the queued changes in, and the surprises
 * (which are about now) are hidden (spec 007).
 */
export function DayTab({
  flashChoreId,
  flashRunId,
}: {
  flashChoreId: number | null;
  flashRunId: number | null;
}) {
  const ui = useParentUi();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<number | 'all'>('all');
  const pc = useFamilyPc();
  const pending = usePendingChores();
  const today = usePlanDay('today');
  const date = selected ?? today.data?.today ?? 'today';
  const day = usePlanDay(date === today.data?.today ? 'today' : date);
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

      {plan.paused && (
        <div className={holiday.dayBanner}>
          🌴 Holiday pause: no quests {isToday ? 'today' : 'on this day'}
        </div>
      )}
      <DayAxis />
      {isToday && pc === 'on' && (
        <SurprisesToday
          kids={plan.children}
          timezone={plan.timezone}
          clockOffsetMs={day.data?.clockOffsetMs ?? 0}
          flashRunId={flashRunId}
          filter={filter}
        />
      )}
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
            data-skipped={(isToday && skipped) || unplayed || plan.paused || undefined}
            data-flash={flashChoreId === chore.id || undefined}
            onClick={() => ui.openQuest(chore.id)}
          >
            <div className={classes.questHead}>
              <span className={classes.icon}>{chore.icon}</span>
              <b>
                {chore.title}
                {pending.has(chore.id) && (
                  <span className={outbox.pending} title="Waiting to be sent">
                    ⏳
                  </span>
                )}
              </b>
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
          ui.newQuest({
            // A one-off for the day on show, so tomorrow's can be planned tonight (spec 007).
            oneOffOn: plan.date >= plan.today ? plan.date : null,
            childId: filter === 'all' ? undefined : filter,
          })
        }
      >
        ＋ New quest
        {isToday ? ' · or a one-off for today' : plan.date > plan.today ? ' · or a one-off' : ''}
      </DashedButton>
      {isToday && !plan.paused && pc === 'on' && <SurpriseButton />}
    </>
  );
}
