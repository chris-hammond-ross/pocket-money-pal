import {
  choreRunsOn,
  choreStage,
  choreWindow,
  type Chore,
  type DayInstance,
  type SetupChore,
} from '@pmp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { clockTimeAt } from '../../lib/format';
import { sound } from '../../lib/sounds';
import { arcade } from '../../theme';
import { ArcadeButton, PixelLabel } from '../arcade';
import { QuestEditor } from '../QuestEditor';
import { useChoreActions } from './actions';
import { problemText, useDay } from './context';
import classes from './parent.module.css';
import { SendBackSheet } from './SendBackSheet';

/** What the editor is open on: a saved quest, or a new one from the picker. */
export type EditorTarget = { choreId: number } | { draft: SetupChore };

const STAGE_COLOUR = {
  bonus: arcade.bonus,
  due: arcade.due,
  overdue: arcade.overdue,
  late: arcade.late,
} as const;

/** A saved chore in the editor's shape: players as string keys. */
function toDraft(chore: Chore): SetupChore {
  const { id, childIds, ...fields } = chore;
  return { ...fields, key: String(id), childKeys: childIds.map(String) };
}

function toInput(d: SetupChore) {
  return {
    title: d.title,
    icon: d.icon,
    together: d.together,
    bonusBefore: d.bonusBefore,
    dueBy: d.dueBy,
    lateAfter: d.lateAfter,
    basePoints: d.basePoints,
    earlyBonus: d.earlyBonus,
    unpromptedBonus: d.unpromptedBonus,
    latePenalty: d.latePenalty,
    days: d.days,
    oneOffDate: d.oneOffDate,
    childIds: d.childKeys.map(Number),
    libraryId: d.libraryId,
  };
}

/**
 * The quest editor on the phone: saves through the chore API, and for a quest that runs
 * today adds the TODAY rows (mark done, approve, send back, undo) and skip / put back. It
 * stays live while open: the rows follow the server's events.
 */
export function PhoneQuestEditor({
  target,
  onClose,
}: {
  target: EditorTarget;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const today = useDay('today');
  const chores = useQuery({ queryKey: ['chores'], queryFn: api.chores });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const actions = useChoreActions();
  const [sendingBack, setSendingBack] = useState<DayInstance | null>(null);

  const saved = 'choreId' in target ? chores.data?.find((c) => c.id === target.choreId) : null;
  const [initial] = useState<SetupChore | null>(() => ('draft' in target ? target.draft : null));
  const draft = initial ?? (saved ? toDraft(saved) : null);

  const save = useMutation({
    mutationFn: async (next: SetupChore) => {
      const { libraryId, ...input } = toInput(next);
      if (saved) return api.updateChore(saved.id, input);
      return api.createChore({ ...input, libraryId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chores'] });
      void queryClient.invalidateQueries({ queryKey: ['day'] });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteChore(id),
    onSuccess: () => {
      sound.sad();
      onClose();
    },
  });
  const skip = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) => api.skipToday(id, on),
    onSuccess: () => sound.tap(),
  });

  const plan = today.data;
  if (!draft || !plan || !settings.data) return null;

  const children = plan.children;
  const players = children.map((c) => ({
    key: String(c.id),
    name: c.name,
    avatar: c.avatar,
    colour: c.colour,
  }));
  const todayQuest = saved ? plan.quests.find((q) => q.chore.id === saved.id) : undefined;
  const runsToday =
    saved !== null && saved !== undefined && (choreRunsOn(saved, plan.today) || !!todayQuest);
  const stage =
    saved && runsToday
      ? choreStage(choreWindow(plan.today, saved, plan.timezone), plan.serverNow)
      : null;
  const childById = new Map(children.map((c) => [c.id, c]));
  const busy =
    actions.approve.isPending ||
    actions.markDone.isPending ||
    actions.undo.isPending ||
    actions.sendBack.isPending;

  const todaySection = saved && runsToday && todayQuest && (
    <>
      <PixelLabel>TODAY{todayQuest.skipped ? ' · SKIPPED' : ''}</PixelLabel>
      {todayQuest.instances
        .filter((i) => i.status !== 'skipped')
        .map((i) => {
          const child = childById.get(i.childId);
          return (
            <div key={i.id} className={classes.inst}>
              <span className={classes.instAvatar}>{child?.avatar}</span>
              <div className={classes.grow}>
                <b>{child?.name}</b>
                <small>
                  {i.status === 'open'
                    ? i.sentBack
                      ? `↩️ sent back`
                      : 'not done yet'
                    : i.status === 'claimed'
                      ? `claimed ${i.claimedAt ? clockTimeAt(i.claimedAt, plan.timezone) : ''}`
                      : `✅ +${i.points ?? 0}`}
                </small>
              </div>
              {i.status === 'open' && (
                <button type="button" disabled={busy} onClick={() => actions.markDone.mutate(i.id)}>
                  Mark done
                </button>
              )}
              {i.status === 'claimed' && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label="Send back"
                    onClick={() => setSendingBack(i)}
                  >
                    ↩
                  </button>
                  <button
                    type="button"
                    data-tone="green"
                    disabled={busy}
                    onClick={() => {
                      sound.coin();
                      actions.approve.mutate([i.id]);
                    }}
                  >
                    ✓ +{i.points ?? 0}
                  </button>
                </>
              )}
              {i.status === 'approved' && (
                <button type="button" disabled={busy} onClick={() => actions.undo.mutate(i.id)}>
                  Undo
                </button>
              )}
            </div>
          );
        })}
      {choreRunsOn(saved, plan.today) && (
        <ArcadeButton
          tone="ghost"
          size="small"
          disabled={skip.isPending}
          onClick={() => skip.mutate({ id: saved.id, on: !todayQuest.skipped })}
        >
          {todayQuest.skipped ? '↺ Put back on today’s board' : '⏭️ Skip today only'}
        </ArcadeButton>
      )}
    </>
  );

  const sendChild = sendingBack ? childById.get(sendingBack.childId) : undefined;

  return (
    <>
      <QuestEditor
        opened
        chore={draft}
        isNew={!saved}
        players={players}
        centsPerPoint={settings.data.centsPerPoint}
        currency={settings.data.currency}
        colour={stage ? STAGE_COLOUR[stage] : undefined}
        today={todaySection}
        saving={save.isPending}
        error={
          save.error ? problemText(save.error) : remove.error ? problemText(remove.error) : null
        }
        onSave={(next) => save.mutate(next)}
        onDelete={saved ? () => remove.mutate(saved.id) : undefined}
        onClose={onClose}
      />
      <SendBackSheet
        target={
          sendingBack && {
            childName: sendChild?.name ?? '',
            avatar: sendChild?.avatar ?? '',
            title: saved?.title ?? '',
          }
        }
        onKeep={() => setSendingBack(null)}
        onPick={(reason) => {
          if (sendingBack) actions.sendBack.mutate({ id: sendingBack.id, reason });
          setSendingBack(null);
        }}
      />
    </>
  );
}
