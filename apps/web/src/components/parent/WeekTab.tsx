import {
  basePointsOnDay,
  formatMoney,
  pointsToCents,
  weekdayOf,
  WEEKDAYS,
  weeklyBasePoints,
  type Chore,
  type Weekday,
} from '@pmp/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { sendOrQueue, usePendingChores, usePlanChores, usePlanDay } from '../../lib/outbox';
import { DAY_SHORT } from '../../lib/format';
import { sound } from '../../lib/sounds';
import { problemText, useParentUi } from './context';
import { HolidayPause } from './HolidayPause';
import outbox from './outbox.module.css';
import classes from './parent.module.css';

/**
 * The Week tab (spec 003): a row per recurring quest and a column per day. Tapping a cell
 * switches that day on or off and saves at once; tapping a name opens the editor. Below:
 * base points per day, each child's week on time in points and money, and the holiday
 * pause (ADR 0016).
 */
export function WeekTab() {
  const ui = useParentUi();
  const queryClient = useQueryClient();
  // With the PC off, the toggles wait on this phone (spec 007) and show as if saved.
  const chores = usePlanChores();
  const today = usePlanDay('today');
  const pending = usePendingChores();

  const toggle = useMutation({
    mutationFn: ({ chore, days }: { chore: Chore; days: Weekday[] }) =>
      sendOrQueue(
        { kind: 'chore.update', choreId: chore.id, patch: { days } },
        `${chore.icon} ${chore.title}`,
        (init) => api.updateChore(chore.id, { days }, init),
      ),
    // Show the change straight away; the server's event refetches the truth.
    onMutate: ({ chore, days }) => {
      queryClient.setQueryData<Chore[]>(['chores'], (list) =>
        list?.map((c) => (c.id === chore.id ? { ...c, days } : c)),
      );
    },
    onError: (err) => {
      sound.sad();
      ui.notify({ icon: '⚠️', title: 'Not saved', body: problemText(err), tone: 'error' });
      void queryClient.invalidateQueries({ queryKey: ['chores'] });
    },
  });

  const plan = today.data;
  if (!chores.data || !plan) return null;
  const recurring = chores.data.filter((c) => c.oneOffDate === null);
  const todayDay = weekdayOf(plan.today);

  const flip = (chore: Chore, day: Weekday) => {
    const on = chore.days.includes(day);
    if (on && chore.days.length === 1) {
      sound.sad();
      ui.notify({
        icon: '📅',
        title: 'A quest needs at least one day',
        body: 'Delete it in the editor if it’s no longer needed.',
      });
      return;
    }
    const days = WEEKDAYS.filter((d) => (d === day ? !on : chore.days.includes(d)));
    if (on) sound.tap();
    else sound.pop();
    toggle.mutate({ chore, days });
  };

  return (
    <>
      <p className={classes.weekHint}>
        Tap a square to switch a quest on or off for that day. Tap a name to edit it.
      </p>
      <div className={classes.gridWrap}>
        <table className={classes.grid}>
          <thead>
            <tr>
              <th />
              {WEEKDAYS.map((d) => (
                <th key={d} data-today={d === todayDay || undefined}>
                  {DAY_SHORT[d].slice(0, 2)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recurring.map((chore) => (
              <tr key={chore.id}>
                <td className={classes.name} onClick={() => ui.openQuest(chore.id)}>
                  {pending.has(chore.id) && (
                    <span className={outbox.pendingFirst} title="Waiting to be sent">
                      ⏳
                    </span>
                  )}
                  {chore.icon} {chore.title}
                  {chore.childIds.length === 0 && <small> ⏸ no players</small>}
                </td>
                {WEEKDAYS.map((d) => {
                  const on = chore.days.includes(d);
                  return (
                    <td
                      key={d}
                      className={classes.cell}
                      data-on={on || undefined}
                      role="switch"
                      aria-checked={on}
                      aria-label={`${chore.title} on ${DAY_SHORT[d]}`}
                      onClick={() => flip(chore, d)}
                    >
                      {on && (
                        <div className={classes.dots}>
                          {chore.childIds.map((id) => (
                            <i
                              key={id}
                              style={{
                                background: plan.children.find((c) => c.id === id)?.colour,
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className={classes.totals}>
              <td style={{ textAlign: 'right', color: 'var(--pmp-dim)' }}>base pts</td>
              {WEEKDAYS.map((d) => (
                <td key={d}>{basePointsOnDay(recurring, d)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {recurring.length === 0 && <div className={classes.empty}>No repeating quests yet.</div>}

      <div style={{ marginTop: 12 }}>
        {plan.children.map((child) => {
          const points = weeklyBasePoints(recurring, child.id);
          const money = formatMoney(pointsToCents(points, plan.centsPerPoint), plan.currency);
          return (
            <div key={child.id} className={classes.row}>
              <span className={classes.rowIcon}>{child.avatar}</span>
              <div className={classes.grow}>
                <b>{child.name}</b>
                <small>
                  {points} pts a week on time ≈ {money} · more with bonuses
                </small>
              </div>
            </div>
          );
        })}
      </div>

      <HolidayPause today={plan.today} />
    </>
  );
}
