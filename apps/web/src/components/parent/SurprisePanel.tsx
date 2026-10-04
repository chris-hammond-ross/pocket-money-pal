import {
  formatTimeFrame,
  formatTimeOfDay,
  joinNames,
  parseTimeOfDay,
  stepReward,
  stepTimeFrame,
  SURPRISE_DEFAULTS,
  SURPRISE_ICONS,
  SURPRISE_REWARD,
  SURPRISE_TIME_FRAMES,
  SURPRISE_TITLE_MAX,
  surpriseTimeSlots,
  zonedTimeOf,
  type QuietHours,
  type SurpriseRun,
  type SurpriseSend,
  type SurpriseTask,
  type SurpriseWho,
} from '@pmp/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { clockTime } from '../../lib/format';
import { useServerNow } from '../../lib/server-clock';
import { sound } from '../../lib/sounds';
import { arcade } from '../../theme';
import { ArcadeButton, CloseButton, Sheet } from '../arcade';
import { problemText, useDay, useParentUi, usePlayers, useSurpriseTasks } from './context';
import parentClasses from './parent.module.css';
import classes from './surprise.module.css';

/** A child as the panel's "who" step shows them. */
interface Kid {
  id: number;
  name: string;
  avatar: string;
  colour: string;
  sick: boolean;
}

interface Draft {
  title: string;
  icon: string;
  rewardPoints: number;
}

/**
 * The surprise panel (spec 006): which quest, who can accept it, when it appears, and how
 * long it stays up, then "⚡ Send now" or "📌 Schedule". Reopened from a scheduled row, it
 * changes that run (and can take it back).
 */
export function SurprisePanel({
  scheduled,
  onClose,
}: {
  scheduled: SurpriseRun | null;
  onClose: () => void;
}) {
  const today = useDay('today');
  const tasks = useSurpriseTasks();
  const players = usePlayers();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const plan = today.data;
  if (!plan || !tasks.data || !settings.data) return null;
  const sick = new Set((players.data ?? []).filter((p) => p.sickToday).map((p) => p.id));
  const kids = plan.children.map((c) => ({ ...c, sick: sick.has(c.id) }));
  return (
    <Panel
      scheduled={scheduled}
      tasks={tasks.data}
      kids={kids}
      today={plan.today}
      timezone={plan.timezone}
      clockOffsetMs={plan.clockOffsetMs}
      quiet={settings.data.quietHours}
      onClose={onClose}
    />
  );
}

function Panel({
  scheduled,
  tasks,
  kids,
  today,
  timezone,
  clockOffsetMs,
  quiet,
  onClose,
}: {
  scheduled: SurpriseRun | null;
  tasks: SurpriseTask[];
  kids: Kid[];
  today: string;
  timezone: string;
  clockOffsetMs: number;
  quiet: QuietHours | null;
  onClose: () => void;
}) {
  const ui = useParentUi();
  const now = useServerNow(clockOffsetMs);
  // A scheduled run reopens on its saved quest, unless that was changed or deleted since.
  const saved = scheduled && tasks.find((t) => t.id === scheduled.taskId);
  const sameAsSaved =
    saved &&
    saved.title === scheduled.title &&
    saved.icon === scheduled.icon &&
    saved.rewardPoints === scheduled.rewardPoints;
  const [sel, setSel] = useState<number | 'new' | null>(() =>
    scheduled ? (sameAsSaved ? saved.id : 'new') : tasks.length === 0 ? 'new' : null,
  );
  const [draft, setDraft] = useState<Draft>(() =>
    scheduled && !sameAsSaved
      ? { title: scheduled.title, icon: scheduled.icon, rewardPoints: scheduled.rewardPoints }
      : { title: '', icon: SURPRISE_DEFAULTS.icon, rewardPoints: SURPRISE_DEFAULTS.rewardPoints },
  );
  const [keep, setKeep] = useState(!scheduled);
  const [who, setWho] = useState<SurpriseWho>(scheduled?.who ?? 'all');
  const [timeFrame, setTimeFrame] = useState<number>(
    scheduled?.timeFrameMin ?? SURPRISE_DEFAULTS.timeFrameMin,
  );
  const [when, setWhen] = useState<'now' | 'at'>(scheduled ? 'at' : 'now');
  const [at, setAt] = useState<string | null>(
    scheduled?.appearAt ? zonedTimeOf(scheduled.appearAt, timezone) : null,
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const well = kids.filter((k) => !k.sick);
  const slots = surpriseTimeSlots(today, now, timezone, quiet);
  const atValid = when === 'now' || (at !== null && slots.includes(at));
  const chosen: Draft | undefined = sel === 'new' ? draft : tasks.find((t) => t.id === sel);
  const ready = !!chosen && chosen.title.trim().length > 0 && atValid && !busy;

  /** A saved quest's default who, if that child can take it today. */
  const usableWho = (w: SurpriseWho): SurpriseWho =>
    w === 'all' || well.some((k) => k.id === w) ? w : 'all';

  const choose = (task: SurpriseTask | 'new') => {
    sound.tap();
    setEditing(null);
    if (task === 'new') {
      setSel('new');
      return;
    }
    setSel(task.id);
    setWho(usableWho(task.who));
    setTimeFrame(task.timeFrameMin);
  };

  const pickWhen = (w: 'now' | 'at') => {
    sound.tap();
    setWhen(w);
    if (w === 'at' && (at === null || !slots.includes(at))) setAt(slots[0] ?? null);
  };

  const submit = async () => {
    if (!chosen || !ready) return;
    const appearAt = when === 'at' && at ? { appearAt: at } : {};
    const body: SurpriseSend =
      sel === 'new'
        ? {
            task: { ...draft, title: draft.title.trim() },
            who,
            timeFrameMin: timeFrame,
            save: keep,
            ...appearAt,
          }
        : { taskId: sel!, who, timeFrameMin: timeFrame, ...appearAt };
    setBusy(true);
    try {
      const run = scheduled
        ? await api.updateSurprise(scheduled.id, body)
        : await api.sendSurprise(body);
      if (when === 'now') {
        sound.whoosh();
      } else {
        sound.pop();
        ui.notify({
          icon: '📌',
          title: `‘${run.title}’ is set for ${clockTime(at!)}`,
          body: 'Tap its row on the timeline to change it',
        });
      }
      ui.flashSurprise(run.id);
      onClose();
    } catch (err) {
      sound.sad();
      ui.notify({ icon: '⚠️', title: 'That didn’t work', body: problemText(err), tone: 'error' });
      setBusy(false);
    }
  };

  const takeBack = async () => {
    if (!scheduled) return;
    setBusy(true);
    try {
      await api.cancelSurprise(scheduled.id);
      sound.sad();
      onClose();
    } catch (err) {
      ui.notify({ icon: '⚠️', title: 'That didn’t work', body: problemText(err), tone: 'error' });
      setBusy(false);
    }
  };

  const footerLabel =
    when === 'now'
      ? '⚡ Send now'
      : at && atValid
        ? `📌 ${scheduled ? 'Save' : 'Schedule'} for ${clockTime(at)}`
        : '📌 Pick a time';

  return (
    <Sheet
      opened
      onClose={onClose}
      colour={arcade.surprise}
      head={
        <>
          <span className={parentClasses.sheetTitle}>
            ⚡ {scheduled ? 'Scheduled surprise' : 'Surprise quest'}
          </span>
          <CloseButton onClick={onClose} />
        </>
      }
      footer={
        <>
          <button type="button" className={classes.go} disabled={!ready} onClick={submit}>
            {footerLabel}
          </button>
          {scheduled && (
            <button type="button" className={classes.cancel} disabled={busy} onClick={takeBack}>
              ✕ Cancel this surprise
            </button>
          )}
        </>
      }
    >
      <Step n={1}>WHICH QUEST</Step>
      {tasks.map((task) => (
        <div key={task.id}>
          <div
            className={classes.task}
            data-on={sel === task.id || undefined}
            role="radio"
            aria-checked={sel === task.id}
            tabIndex={0}
            onClick={() => choose(task)}
            onKeyDown={(e) => e.key === 'Enter' && choose(task)}
          >
            <span className={classes.taskIcon}>{task.icon}</span>
            <span className={classes.taskText}>
              <b>{task.title}</b>
              <small>
                <em>+{task.rewardPoints}</em> · {whoText(task.who, kids)} ·{' '}
                {formatTimeFrame(task.timeFrameMin)}
              </small>
            </span>
            <button
              type="button"
              className={classes.edit}
              aria-label={`Edit ${task.title}`}
              onClick={(e) => {
                e.stopPropagation();
                sound.tap();
                setEditing(editing === task.id ? null : task.id);
              }}
            >
              ✏️
            </button>
            <span className={classes.radio} />
          </div>
          {editing === task.id && (
            <TaskEditor
              task={task}
              kids={kids}
              onDone={(deleted) => {
                setEditing(null);
                if (deleted && sel === task.id) setSel(null);
              }}
            />
          )}
        </div>
      ))}
      <div
        className={classes.task}
        data-new
        data-on={sel === 'new' || undefined}
        role="radio"
        aria-checked={sel === 'new'}
        tabIndex={0}
        onClick={() => choose('new')}
        onKeyDown={(e) => e.key === 'Enter' && choose('new')}
      >
        <span className={classes.taskIcon}>＋</span>
        <span className={classes.taskText}>Create a new one</span>
        <span className={classes.radio} />
      </div>
      {sel === 'new' && (
        <div className={classes.form}>
          <QuestFields value={draft} onChange={setDraft} autoFocus={!scheduled} />
          <button
            type="button"
            className={classes.keep}
            data-on={keep || undefined}
            onClick={() => {
              sound.tap();
              setKeep((k) => !k);
            }}
          >
            <i>{keep && '✓'}</i>Save it to the list for next time
          </button>
        </div>
      )}

      <Step n={2}>WHO CAN ACCEPT IT</Step>
      <div className={classes.tiles}>
        <button
          type="button"
          className={classes.tile}
          data-on={who === 'all' || undefined}
          onClick={() => {
            sound.tap();
            setWho('all');
          }}
        >
          <span className={classes.tileAvatar}>👫</span>
          All children
          <small>{well.length >= 2 ? 'first to grab, or all together' : 'first to grab'}</small>
        </button>
        {kids.map((kid) => (
          <button
            key={kid.id}
            type="button"
            className={classes.tile}
            style={{ '--c': kid.colour } as CSSProperties}
            data-on={who === kid.id || undefined}
            disabled={kid.sick}
            onClick={() => {
              sound.tap();
              setWho(kid.id);
            }}
          >
            <span className={classes.tileAvatar}>{kid.avatar}</span>
            {kid.name}
            <small>{kid.sick ? 'sick day 🤒' : `only ${kid.name}`}</small>
          </button>
        ))}
      </div>

      <Step n={3}>WHEN DOES IT APPEAR</Step>
      <div className={classes.when}>
        <button type="button" data-on={when === 'now' || undefined} onClick={() => pickWhen('now')}>
          ⚡ Right away
        </button>
        <button type="button" data-on={when === 'at' || undefined} onClick={() => pickWhen('at')}>
          🕒 At a set time
        </button>
      </div>
      {when === 'at' &&
        (slots.length === 0 ? (
          <div className={classes.tooLate}>
            Too late today
            {quiet ? `: quiet hours start at ${clockTime(quiet.from)}` : ''}
          </div>
        ) : (
          <label className={classes.at}>
            Today at
            <select value={at ?? ''} onChange={(e) => setAt(e.target.value)}>
              {at !== null && !slots.includes(at) && (
                <option value={at} disabled>
                  {clockTime(at)} (too soon now)
                </option>
              )}
              {slots.map((slot) => (
                <option key={slot} value={slot}>
                  {clockTime(slot)}
                </option>
              ))}
            </select>
          </label>
        ))}

      <Step n={4}>TIME FRAME</Step>
      <div className={classes.field}>
        They have this long to accept it
        <TimeFrameStepper value={timeFrame} onChange={setTimeFrame} />
      </div>

      {chosen && chosen.title.trim() && (
        <p className={classes.summary}>
          <Summary
            title={chosen.title.trim()}
            reward={chosen.rewardPoints}
            who={who}
            kids={well}
            when={when === 'at' && at ? at : null}
            timeFrame={timeFrame}
          />
        </p>
      )}
    </Sheet>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className={classes.step}>
      <i>{n}</i>
      {children}
    </div>
  );
}

/** "all children" or "only Alice". */
function whoText(who: SurpriseWho, kids: readonly Kid[]): string {
  if (who === 'all') return 'all children';
  return `only ${kids.find((k) => k.id === who)?.name ?? 'one child'}`;
}

/** The summary above the footer: the choice read back (spec 006). */
function Summary({
  title,
  reward,
  who,
  kids,
  when,
  timeFrame,
}: {
  title: string;
  reward: number;
  who: SurpriseWho;
  kids: readonly Kid[];
  when: string | null;
  timeFrame: number;
}) {
  const frame = formatTimeFrame(timeFrame);
  const until = when
    ? ` (until ${clockTime(formatTimeOfDay((parseTimeOfDay(when) + timeFrame) % (24 * 60)))})`
    : '';
  const names = kids.map((k) => k.name);
  const people =
    who !== 'all'
      ? `Only ${kids.find((k) => k.id === who)?.name ?? 'one child'} can accept it`
      : names.length >= 2
        ? `${joinNames(names)} race for it, or say “We’ll all do it!” and each get +${reward}`
        : `${names[0] ?? 'Nobody'} can grab it`;
  return (
    <>
      <b>{title}</b> (+{reward}) pops up on the kiosk{' '}
      <b>{when ? `at ${clockTime(when)}` : 'right away'}</b>. {people}, and it stays up for{' '}
      <b>{frame}</b>
      {until}.
    </>
  );
}

/** Title, icon and reward: the new-quest form and the saved-quest editor share these. */
function QuestFields({
  value,
  onChange,
  autoFocus,
}: {
  value: Draft;
  onChange: (draft: Draft) => void;
  autoFocus?: boolean;
}) {
  const [showIcons, setShowIcons] = useState(false);
  return (
    <>
      <div className={classes.titleRow}>
        <button
          type="button"
          className={classes.iconButton}
          aria-label="Pick an icon"
          onClick={() => {
            sound.tap();
            setShowIcons((s) => !s);
          }}
        >
          {value.icon}
        </button>
        <input
          value={value.title}
          maxLength={SURPRISE_TITLE_MAX}
          placeholder="What's the quest?"
          // Focused straight away when "Create a new one" is picked (spec 006).
          autoFocus={autoFocus}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
      </div>
      {showIcons && (
        <div className={classes.icons}>
          {SURPRISE_ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              data-on={icon === value.icon || undefined}
              onClick={() => {
                sound.tap();
                onChange({ ...value, icon });
                setShowIcons(false);
              }}
            >
              {icon}
            </button>
          ))}
        </div>
      )}
      <div className={classes.field}>
        Reward
        <div className={classes.stepper}>
          <button
            type="button"
            aria-label="Less"
            disabled={value.rewardPoints <= SURPRISE_REWARD.min}
            onClick={() => onChange({ ...value, rewardPoints: stepReward(value.rewardPoints, -1) })}
          >
            −
          </button>
          <span>+{value.rewardPoints}</span>
          <button
            type="button"
            aria-label="More"
            disabled={value.rewardPoints >= SURPRISE_REWARD.max}
            onClick={() => onChange({ ...value, rewardPoints: stepReward(value.rewardPoints, 1) })}
          >
            +
          </button>
        </div>
      </div>
    </>
  );
}

function TimeFrameStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const first = SURPRISE_TIME_FRAMES[0];
  const last = SURPRISE_TIME_FRAMES[SURPRISE_TIME_FRAMES.length - 1]!;
  return (
    <div className={classes.stepper}>
      <button
        type="button"
        aria-label="Shorter"
        disabled={value <= first}
        onClick={() => {
          sound.tap();
          onChange(stepTimeFrame(value, -1));
        }}
      >
        −
      </button>
      <span>{formatTimeFrame(value)}</span>
      <button
        type="button"
        aria-label="Longer"
        disabled={value >= last}
        onClick={() => {
          sound.tap();
          onChange(stepTimeFrame(value, 1));
        }}
      >
        +
      </button>
    </div>
  );
}

/**
 * ✏️ on a saved quest (spec 006, "Editing and deleting saved quests"): its fields and
 * defaults, 💾 Save, and Delete on a second tap. Runs already sent keep their own copy.
 */
function TaskEditor({
  task,
  kids,
  onDone,
}: {
  task: SurpriseTask;
  kids: readonly Kid[];
  onDone: (deleted: boolean) => void;
}) {
  const ui = useParentUi();
  const [draft, setDraft] = useState<Draft>({
    title: task.title,
    icon: task.icon,
    rewardPoints: task.rewardPoints,
  });
  const [who, setWho] = useState<SurpriseWho>(task.who);
  const [timeFrame, setTimeFrame] = useState(task.timeFrameMin);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, deleted: boolean) => {
    setBusy(true);
    try {
      await action();
      sound.pop();
      onDone(deleted);
    } catch (err) {
      sound.sad();
      ui.notify({ icon: '⚠️', title: 'That didn’t work', body: problemText(err), tone: 'error' });
      setBusy(false);
    }
  };

  return (
    <div className={classes.form}>
      <QuestFields value={draft} onChange={setDraft} />
      <div className={classes.chips}>
        <button type="button" data-on={who === 'all' || undefined} onClick={() => setWho('all')}>
          👫 All children
        </button>
        {kids.map((kid) => (
          <button
            key={kid.id}
            type="button"
            data-on={who === kid.id || undefined}
            onClick={() => setWho(kid.id)}
          >
            {kid.avatar} only {kid.name}
          </button>
        ))}
      </div>
      <div className={classes.field}>
        Time frame
        <TimeFrameStepper value={timeFrame} onChange={setTimeFrame} />
      </div>
      <div className={classes.formButtons}>
        <ArcadeButton
          size="small"
          disabled={busy || draft.title.trim().length === 0}
          onClick={() =>
            void run(
              () =>
                api.updateSurpriseTask(task.id, {
                  ...draft,
                  title: draft.title.trim(),
                  who,
                  timeFrameMin: timeFrame,
                }),
              false,
            )
          }
        >
          💾 Save
        </ArcadeButton>
        <ArcadeButton
          size="small"
          tone="red"
          disabled={busy}
          onClick={() => {
            if (!armed) {
              sound.tap();
              setArmed(true);
              return;
            }
            void run(() => api.deleteSurpriseTask(task.id), true);
          }}
        >
          {armed ? 'Tap again to delete' : 'Delete'}
        </ArcadeButton>
      </div>
    </div>
  );
}
