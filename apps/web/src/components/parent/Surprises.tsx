import {
  formatCountdown,
  formatGrabTime,
  joinNames,
  parseTimeOfDay,
  surpriseRowState,
  zonedTimeOf,
  type SurpriseRowState,
  type SurpriseRun,
  type SurpriseWho,
} from '@pmp/shared';
import { useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { clockTimeAt } from '../../lib/format';
import { useServerNow } from '../../lib/server-clock';
import { sound } from '../../lib/sounds';
import { arcade } from '../../theme';
import {
  ArcadeButton,
  CloseButton,
  PixelLabel,
  PlayerBadge,
  Sheet,
  SurpriseBar,
  type ClaimDot,
  type SurpriseSpan,
} from '../arcade';
import { problemText, useParentUi, useSurprises, useSurpriseTasks } from './context';
import parentClasses from './parent.module.css';
import classes from './surprise.module.css';

interface Child {
  id: number;
  name: string;
  avatar: string;
  colour: string;
}

/** "⚡ Surprise quest" at the bottom of today's Day tab (spec 006). */
export function SurpriseButton() {
  const ui = useParentUi();
  return (
    <button
      type="button"
      className={classes.button}
      onClick={() => {
        sound.tap();
        ui.newSurprise();
      }}
    >
      ⚡ Surprise quest
    </button>
  );
}

/**
 * "⚡ SURPRISES TODAY" on today's Day tab (spec 006): a purple row per surprise sent today,
 * on the same 6am–9pm axis as the quests, with its state. Nothing shows when there's none.
 */
export function SurprisesToday({
  kids,
  timezone,
  clockOffsetMs,
  flashRunId,
  filter,
}: {
  kids: Child[];
  timezone: string;
  clockOffsetMs: number;
  flashRunId: number | null;
  /** The Day tab's player filter: a surprise for all children shows for each of them. */
  filter: number | 'all';
}) {
  const surprises = useSurprises();
  const now = useServerNow(clockOffsetMs);
  const runs = (surprises.data ?? []).filter(
    (r) => filter === 'all' || r.who === 'all' || r.who === filter,
  );
  if (runs.length === 0) return null;
  return (
    <>
      <PixelLabel>⚡ SURPRISES TODAY</PixelLabel>
      {runs.map((run) => (
        <SurpriseRow
          key={run.id}
          run={run}
          kids={kids}
          timezone={timezone}
          now={now}
          flash={flashRunId === run.id}
        />
      ))}
      <PixelLabel>QUESTS</PixelLabel>
    </>
  );
}

/** The children a run is for: its one child, or every child (in column order). */
function eligibleKids(who: SurpriseWho, kids: readonly Child[]): Child[] {
  return who === 'all' ? [...kids] : kids.filter((k) => k.id === who);
}

function SurpriseRow({
  run,
  kids,
  timezone,
  now,
  flash,
}: {
  run: SurpriseRun;
  kids: Child[];
  timezone: string;
  now: number;
  flash: boolean;
}) {
  const ui = useParentUi();
  const again = useSendAgain();
  const state = surpriseRowState(run);
  const minutes = (t: number) => parseTimeOfDay(zonedTimeOf(t, timezone));
  const takers = new Set(run.takers.map((t) => t.childId));
  const anyTaken = takers.size > 0;
  const kidById = new Map(kids.map((k) => [k.id, k]));

  let span: SurpriseSpan | undefined;
  let marker: { minutes: number; icon: string } | undefined;
  let dots: ClaimDot[] = [];
  const tf = run.timeFrameMin;
  switch (state) {
    case 'scheduled':
      marker = { minutes: minutes(run.appearAt!), icon: '⚡' };
      span = { from: minutes(run.appearAt!), to: minutes(run.appearAt!) + tf, tone: 'planned' };
      break;
    case 'queued':
      marker = { minutes: minutes(run.appearAt ?? run.sentAt), icon: '⏳' };
      break;
    case 'live':
      span = { from: minutes(run.shownAt!), to: minutes(run.expiresAt!), tone: 'live' };
      break;
    case 'expired': {
      const from = run.shownAt ?? run.appearAt ?? run.sentAt;
      span = { from: minutes(from), to: minutes(run.endedAt ?? from), tone: 'expired' };
      break;
    }
    case 'grabbed':
    case 'done':
    case 'approved':
      span = { from: minutes(run.shownAt!), to: minutes(run.grabbedAt!), tone: 'grabbed' };
      dots = run.takers.map((t) => ({
        key: t.instanceId,
        minutes: minutes(run.grabbedAt!),
        avatar: kidById.get(t.childId)?.avatar ?? '🙂',
        approved: t.status === 'approved',
      }));
      break;
  }

  const open = () => {
    sound.tap();
    if (state === 'scheduled') ui.newSurprise(run);
    else ui.openSurprise(run.id);
  };

  return (
    <div
      className={`${parentClasses.quest} ${classes.row}`}
      data-state={state}
      data-dim={state === 'approved' || state === 'expired' || undefined}
      data-flash={flash || undefined}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <div className={parentClasses.questHead}>
        <span className={parentClasses.icon}>{run.icon}</span>
        <b>{run.title}</b>
        <span className={parentClasses.who}>
          {eligibleKids(run.who, kids).map((kid) => (
            <span
              key={kid.id}
              className={anyTaken && !takers.has(kid.id) ? classes.badgeDim : undefined}
            >
              <PlayerBadge avatar={kid.avatar} colour={kid.colour} />
            </span>
          ))}
        </span>
        <StateTag run={run} state={state} kids={kids} timezone={timezone} now={now} />
        {state === 'expired' && (
          <button
            type="button"
            className={classes.again}
            disabled={again.busy}
            onClick={(e) => {
              e.stopPropagation();
              void again.send(run, run.who);
            }}
          >
            ↻ again
          </button>
        )}
        <span className={parentClasses.points}>+{run.rewardPoints}</span>
      </div>
      <SurpriseBar span={span} marker={marker} dots={dots} nowMinutes={minutes(now)} />
    </div>
  );
}

function StateTag({
  run,
  state,
  kids,
  timezone,
  now,
}: {
  run: SurpriseRun;
  state: SurpriseRowState;
  kids: Child[];
  timezone: string;
  now: number;
}) {
  let text: ReactNode;
  switch (state) {
    case 'scheduled':
      text = `🕒 ${clockTimeAt(run.appearAt!, timezone)}`;
      break;
    case 'queued':
      text = '⏳ next up';
      break;
    case 'live':
      text = formatCountdown((run.expiresAt ?? now) - now);
      break;
    case 'grabbed':
      text = run.team
        ? '👫 all on it'
        : `${kids.find((k) => k.id === run.takers[0]?.childId)?.name ?? 'Someone'} is on it`;
      break;
    case 'done':
      text = 'to check ↓';
      break;
    case 'approved':
      text = '✓ approved';
      break;
    case 'expired':
      text = '😴 nobody';
      break;
    case 'cancelled':
      return null;
  }
  return (
    <span className={classes.tag} data-state={state}>
      {text}
    </span>
  );
}

/** "↻ again", "Send it again" and "Send to Billy only": the same quest, right away. */
function useSendAgain() {
  const ui = useParentUi();
  const tasks = useSurpriseTasks();
  const [busy, setBusy] = useState(false);
  const send = async (run: SurpriseRun, who: SurpriseWho) => {
    setBusy(true);
    // The saved quest if it's still in the list; otherwise the run's own copy, once.
    const saved = tasks.data?.find((t) => t.id === run.taskId);
    try {
      const next = await api.sendSurprise(
        saved
          ? { taskId: saved.id, who, timeFrameMin: run.timeFrameMin }
          : {
              task: { title: run.title, icon: run.icon, rewardPoints: run.rewardPoints },
              who,
              timeFrameMin: run.timeFrameMin,
            },
      );
      sound.whoosh();
      ui.flashSurprise(next.id);
      return true;
    } catch (err) {
      sound.sad();
      ui.notify({ icon: '⚠️', title: 'That didn’t work', body: problemText(err), tone: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { send, busy };
}

/**
 * A SURPRISES TODAY row's sheet (spec 006): take back one that's waiting or up on the
 * kiosk; who took one and how fast; or, after nobody grabbed it, send it again.
 */
export function SurpriseSheet({
  runId,
  kids,
  clockOffsetMs,
  onClose,
}: {
  runId: number;
  kids: Child[];
  clockOffsetMs: number;
  onClose: () => void;
}) {
  const ui = useParentUi();
  const surprises = useSurprises();
  const again = useSendAgain();
  const now = useServerNow(clockOffsetMs);
  const [busy, setBusy] = useState(false);
  const run = surprises.data?.find((r) => r.id === runId);
  if (!run) return null;
  const state = surpriseRowState(run);
  const kidById = new Map(kids.map((k) => [k.id, k]));
  const names = run.takers.map((t) => kidById.get(t.childId)?.name ?? 'Someone');
  const fast =
    run.grabbedAt !== null && run.shownAt !== null
      ? ` in ${formatGrabTime(run.grabbedAt - run.shownAt)}`
      : '';

  const takeBack = async () => {
    setBusy(true);
    try {
      await api.cancelSurprise(run.id);
      sound.sad();
      onClose();
    } catch (err) {
      ui.notify({ icon: '⚠️', title: 'That didn’t work', body: problemText(err), tone: 'error' });
      setBusy(false);
    }
  };
  const sendAgain = async (who: SurpriseWho) => {
    if (await again.send(run, who)) onClose();
  };

  let body: ReactNode;
  let footer: ReactNode = null;
  if (state === 'queued' || state === 'live') {
    body = (
      <p className={parentClasses.centre}>
        {state === 'live'
          ? `Up on the kiosk now · ${formatCountdown((run.expiresAt ?? now) - now)} left`
          : 'Waiting for the surprise on the kiosk now to finish'}
      </p>
    );
    footer = (
      <ArcadeButton tone="red" disabled={busy} onClick={takeBack}>
        ✕ Take it back
      </ArcadeButton>
    );
  } else if (state === 'expired') {
    body = (
      <>
        <p className={parentClasses.centre}>Nobody grabbed it this time.</p>
        <div className={classes.choices}>
          <button type="button" disabled={again.busy} onClick={() => void sendAgain(run.who)}>
            ⚡ Send it again
          </button>
          {kids.map((kid) => (
            <button
              key={kid.id}
              type="button"
              disabled={again.busy}
              onClick={() => void sendAgain(kid.id)}
            >
              {kid.avatar} Send to {kid.name} only
            </button>
          ))}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className={parentClasses.centre}>
          {run.team
            ? `👫 ${joinNames(names)} took it on together${fast}`
            : `${names[0]} grabbed it${fast}`}
        </p>
        <div className={classes.takers}>
          {run.takers.map((t) => {
            const kid = kidById.get(t.childId);
            return (
              <div key={t.instanceId} className={classes.taker}>
                <PlayerBadge avatar={kid?.avatar ?? '🙂'} colour={kid?.colour ?? arcade.gold} />
                <b>{kid?.name ?? 'A player'}</b>
                <span>
                  {t.status === 'open'
                    ? 'on it'
                    : t.status === 'claimed'
                      ? 'done · to check in the tray'
                      : t.status === 'approved'
                        ? `✓ +${run.rewardPoints}`
                        : 'skipped'}
                </span>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <Sheet
      opened
      short
      onClose={onClose}
      colour={arcade.surprise}
      head={
        <>
          <span className={parentClasses.sheetTitle}>
            {run.icon} {run.title} <span style={{ color: arcade.gold }}>+{run.rewardPoints}</span>
          </span>
          <CloseButton onClick={onClose} />
        </>
      }
      footer={footer}
    >
      <div className={classes.sheetBody}>{body}</div>
    </Sheet>
  );
}
