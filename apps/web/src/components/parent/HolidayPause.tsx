import {
  addDays,
  currentPause,
  daysBetween,
  PAUSE_MAX_DAYS,
  PAUSE_PRESETS,
  pauseProblem,
  pauseState,
  pauseUntilFor,
  type SchedulePause,
} from '@pmp/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { sendOrQueue, usePlanSettings } from '../../lib/outbox';
import { formatDate } from '../../lib/format';
import { sound } from '../../lib/sounds';
import { ArcadeButton, CloseButton, PixelLabel, Sheet } from '../arcade';
import { problemText, useParentUi } from './context';
import { pauseName } from './Outbox';
import classes from './holiday.module.css';
import parentClasses from './parent.module.css';

const HOLIDAY = '#3bc9db';

type Length = (typeof PAUSE_PRESETS)[number]['key'] | 'date';

/** "Back on Sat 18 Oct · 5 days away", or "Until you resume". */
function backLine(pause: SchedulePause, today: string): string {
  if (pause.until === null) return 'Until you resume';
  const backOn = addDays(pause.until, 1);
  const days = daysBetween(today, backOn);
  return `Back on ${formatDate(backOn)} · ${days === 1 ? 'tomorrow' : `in ${days} days`}`;
}

function useSetPause(onDone: (pause: SchedulePause | null) => void) {
  const ui = useParentUi();
  const queryClient = useQueryClient();
  return useMutation({
    // With the PC off, it waits on this phone (spec 007) and shows as if saved.
    mutationFn: (pause: SchedulePause | null) =>
      sendOrQueue({ kind: 'pause', pause }, pauseName(pause), (init) => api.setPause(pause, init)),
    onSuccess: (sent, pause) => {
      if (!sent.queued) queryClient.setQueryData(['settings'], sent.result);
      onDone(pause);
      if (sent.queued) {
        ui.notify({
          icon: '⏳',
          title: 'Saved on this phone',
          body: 'The holiday goes to the family PC as soon as this phone can reach it.',
        });
      }
    },
    onError: (err) => {
      sound.sad();
      ui.notify({ icon: '⚠️', title: 'Not saved', body: problemText(err), tone: 'error' });
    },
  });
}

/**
 * HOLIDAY at the bottom of the Week tab (ADR 0016): "🌴 Pause quests", or the pause going
 * on or still to come with Change and Resume. Paused days get no quests, so streaks are
 * safe; payday and surprises wait too.
 */
export function HolidayPause({ today }: { today: string }) {
  const ui = useParentUi();
  const settings = usePlanSettings();
  const [sheet, setSheet] = useState<'pause' | 'resume' | null>(null);
  const callOff = useSetPause(() => {
    sound.tap();
    ui.notify({ icon: '🌴', title: 'Holiday called off', body: 'Quests carry on as usual.' });
  });
  if (!settings.data) return null;
  const pause = currentPause(settings.data.pause, today);
  const state = pauseState(pause, today);

  return (
    <div className={classes.section}>
      <PixelLabel>HOLIDAY</PixelLabel>
      {pause === null ? (
        <>
          <button
            type="button"
            className={classes.pauseButton}
            onClick={() => {
              sound.tap();
              setSheet('pause');
            }}
          >
            🌴 Pause quests
          </button>
          <p className={parentClasses.note}>
            Going away? Pause every quest so nobody’s streak breaks while you’re gone.
          </p>
        </>
      ) : (
        <div className={classes.card} data-state={state}>
          <span className={classes.cardIcon}>🌴</span>
          <div className={parentClasses.grow}>
            <b>
              {state === 'active' ? 'Quests are paused' : `Pause starts ${formatDate(pause.from)}`}
            </b>
            <small>{backLine(pause, today)}</small>
          </div>
          <div className={classes.cardActions}>
            <button
              type="button"
              onClick={() => {
                sound.tap();
                setSheet('pause');
              }}
            >
              ✏️ Change
            </button>
            {state === 'active' ? (
              <button
                type="button"
                data-tone="go"
                onClick={() => {
                  sound.tap();
                  setSheet('resume');
                }}
              >
                ▶ Resume
              </button>
            ) : (
              <button
                type="button"
                disabled={callOff.isPending}
                onClick={() => callOff.mutate(null)}
              >
                ✕ Call off
              </button>
            )}
          </div>
        </div>
      )}

      {sheet === 'pause' && (
        <PauseSheet current={pause} today={today} onClose={() => setSheet(null)} />
      )}
      {sheet === 'resume' && pause && (
        <ResumeSheet pause={pause} today={today} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

/**
 * "🌴 Pause quests": when it starts (today or tomorrow) and how long (3 days, a week, two
 * weeks, until you resume, or a "back on" date). Editing the pause going on keeps its start.
 */
function PauseSheet({
  current,
  today,
  onClose,
}: {
  current: SchedulePause | null;
  today: string;
  onClose: () => void;
}) {
  const ui = useParentUi();
  const ongoing = pauseState(current, today) === 'active';
  const tomorrow = addDays(today, 1);
  const starts = [today, tomorrow, ...(current && !ongoing ? [current.from] : [])].filter(
    (d, i, all) => all.indexOf(d) === i,
  );
  const [from, setFrom] = useState(current?.from ?? today);
  const [length, setLength] = useState<Length>(
    current === null ? '1w' : current.until === null ? 'open' : 'date',
  );
  const [backOn, setBackOn] = useState(
    current?.until ? addDays(current.until, 1) : addDays(from, 7),
  );

  const preset = PAUSE_PRESETS.find((p) => p.key === length);
  const until =
    length === 'date'
      ? addDays(backOn, -1)
      : preset?.days == null
        ? null
        : pauseUntilFor(from, preset.days);
  const next: SchedulePause = { from, until };
  const problem =
    until !== null && until < from
      ? 'Pick a day after it starts'
      : pauseProblem(next, current, today);

  const save = useSetPause(() => {
    sound.pop();
    ui.notify({
      icon: '🌴',
      title: current ? 'Holiday changed' : 'Quests paused',
      body: `${until === null ? 'Until you resume' : `Back on ${formatDate(addDays(until, 1))}`}. Enjoy the break!`,
    });
    onClose();
  });

  return (
    <Sheet
      opened
      short
      colour={HOLIDAY}
      onClose={onClose}
      head={
        <>
          <span className={parentClasses.sheetTitle}>
            🌴 {current ? 'Change the holiday' : 'Pause quests'}
          </span>
          <CloseButton onClick={onClose} />
        </>
      }
      footer={
        <ArcadeButton
          disabled={problem !== null || save.isPending}
          onClick={() => save.mutate(next)}
        >
          {current ? '💾 Save' : '🌴 Pause quests'}
        </ArcadeButton>
      }
    >
      <div className={classes.step}>STARTS</div>
      {ongoing ? (
        <p className={parentClasses.lead}>Started {formatDate(from)}</p>
      ) : (
        <div className={classes.chips}>
          {starts.map((d) => (
            <button
              key={d}
              type="button"
              data-on={from === d || undefined}
              onClick={() => {
                sound.tap();
                setFrom(d);
              }}
            >
              {d === today ? 'Today' : d === tomorrow ? 'Tomorrow' : formatDate(d)}
            </button>
          ))}
        </div>
      )}

      <div className={classes.step}>{ongoing ? 'UNTIL' : 'FOR'}</div>
      <div className={classes.chips}>
        {PAUSE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            data-on={length === p.key || undefined}
            onClick={() => {
              sound.tap();
              setLength(p.key);
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          data-on={length === 'date' || undefined}
          onClick={() => {
            sound.tap();
            setLength('date');
          }}
        >
          📅 Pick a day
        </button>
      </div>
      {length === 'date' && (
        <label className={classes.dateRow}>
          Back on
          <input
            type="date"
            value={backOn}
            min={addDays(from > today ? from : today, 1)}
            max={addDays(from, PAUSE_MAX_DAYS)}
            onChange={(e) => e.target.value && setBackOn(e.target.value)}
          />
        </label>
      )}

      <p className={classes.summary}>
        {problem ??
          (until === null
            ? `No quests from ${formatDate(from)} until you resume.`
            : `No quests ${from === until ? `on ${formatDate(from)}` : `from ${formatDate(from)} to ${formatDate(until)}`}. Back on ${formatDate(addDays(until, 1))}.`)}
      </p>
      <ul className={classes.facts}>
        <li>🔥 Streaks are safe: paused days don’t count.</li>
        <li>💰 No payday while you’re away. Points carry over to the next one.</li>
        <li>⚡ No surprise quests. The kiosk shows a holiday screen.</li>
        {from === today && !ongoing && (
          <li>📋 Today’s quests leave the kiosk now. Anything claimed still waits for you.</li>
        )}
      </ul>
    </Sheet>
  );
}

/** "▶ Resume quests?": from tomorrow (today stays off), or right now. */
function ResumeSheet({
  pause,
  today,
  onClose,
}: {
  pause: SchedulePause;
  today: string;
  onClose: () => void;
}) {
  const ui = useParentUi();
  const save = useSetPause((next) => {
    sound.pop();
    ui.notify(
      next === null
        ? { icon: '▶️', title: 'Quests are back', body: 'Today’s quests are on the kiosk again.' }
        : { icon: '🌙', title: 'Quests are back tomorrow', body: 'Today stays a day off.' },
    );
    onClose();
  });
  const endsToday = pause.until === today;

  return (
    <Sheet
      opened
      short
      colour={HOLIDAY}
      onClose={onClose}
      head={
        <>
          <span className={parentClasses.sheetTitle}>▶ Resume quests?</span>
          <CloseButton onClick={onClose} />
        </>
      }
      footer={
        <ArcadeButton tone="ghost" onClick={onClose}>
          Keep the holiday
        </ArcadeButton>
      }
    >
      <div className={parentClasses.reasons}>
        {!endsToday && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({ from: pause.from, until: today })}
          >
            🌙 From tomorrow · today stays a day off
          </button>
        )}
        <button type="button" disabled={save.isPending} onClick={() => save.mutate(null)}>
          ⚡ Right now · today’s quests come back
        </button>
      </div>
      <p className={parentClasses.note}>
        {endsToday ? 'The holiday already ends tonight. ' : ''}
        Right now brings today’s quests back at once: any whose time has passed come back late, and
        anything not done by tonight counts as missed.
      </p>
    </Sheet>
  );
}
