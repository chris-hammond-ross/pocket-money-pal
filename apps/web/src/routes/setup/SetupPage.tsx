/**
 * First-run setup at /setup (spec 003, ADR 0005): title, game masters, player select, hand
 * out quests, today's board. Works on a phone (arriving from the kiosk's QR code with the
 * setup token) or on the family PC itself.
 */
import {
  SETUP_STAGES,
  gameMastersProblem,
  nextPlayerLook,
  removePlayerFromDraft,
  toggleQuestForPlayer,
  zonedDateOf,
  DEFAULT_CHILD_AGE,
  WEEKDAYS,
  type ChoreLibraryItem,
  type SetupChild,
  type SetupChore,
  type SetupDraft,
  type SetupResult,
  type SetupStatus,
} from '@pmp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ArcadeButton } from '../../components/arcade';
import { PlayerEditor } from '../../components/PlayerEditor';
import { QuestEditor } from '../../components/QuestEditor';
import { ApiError, api } from '../../lib/api';
import { celebrate } from '../../lib/confetti';
import { browserTimeZone, newKey } from '../../lib/format';
import { SETUP_ONLY_QUERIES } from '../../lib/live-events';
import { captureSetupToken, forgetSetupToken } from '../../lib/setup-token';
import { sound } from '../../lib/sounds';
import classes from './setup.module.css';
import { BoardStage, MastersStage, PlayersStage, QuestsStage, TitleStage } from './stages';
import { EMPTY_DRAFT, useSetupDraft } from './use-setup-draft';

const MAX_PARENTS = 6;

export function SetupPage() {
  useState(captureSetupToken);
  const navigate = useNavigate();
  const [finishing, setFinishing] = useState(false);

  const status = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus });
  const needed = status.data?.needed === true;
  const draft = useQuery({
    queryKey: ['setup-draft'],
    queryFn: api.setupDraft,
    enabled: needed && !finishing,
    retry: false,
    staleTime: Infinity,
  });
  const library = useQuery({ queryKey: ['chore-library'], queryFn: api.choreLibrary });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });

  if (status.data && !needed && !finishing) return <Navigate to="/parent" replace />;
  if (draft.error instanceof ApiError && draft.error.code === 'setup-token') return <ScanTheCode />;
  if (draft.error instanceof ApiError && draft.error.status === 409 && !finishing) {
    return <Navigate to="/parent" replace />;
  }
  if (!status.data || !draft.isSuccess || !library.data) return null;

  return (
    <SetupFlow
      initial={draft.data ?? EMPTY_DRAFT}
      library={library.data}
      currency={settings.data?.currency ?? 'GBP'}
      onFinishing={() => setFinishing(true)}
      onFailed={() => setFinishing(false)}
      onFinished={(result) =>
        navigate(result.paired || !status.data.onPc ? '/parent' : '/kiosk', {
          replace: true,
          state: { justSetUp: true },
        })
      }
    />
  );
}

function ScanTheCode() {
  return (
    <div className={classes.shell}>
      <div className={classes.scan}>
        <div className={classes.logo}>🐷</div>
        <h2>SCAN THE CODE</h2>
        <p>
          To set up Pocket Money Pal on this phone, scan the QR code on the family PC’s screen. That
          link lets this phone in.
        </p>
        <p>You can also do the setup on the PC itself.</p>
      </div>
    </div>
  );
}

function newChore(childKey: string): SetupChore {
  return {
    key: newKey('own'),
    libraryId: null,
    title: '',
    icon: '⭐',
    together: false,
    bonusBefore: '16:00',
    dueBy: '17:00',
    lateAfter: '19:00',
    basePoints: 5,
    earlyBonus: 2,
    unpromptedBonus: 2,
    latePenalty: 2,
    days: [...WEEKDAYS],
    oneOffDate: null,
    childKeys: [childKey],
  };
}

type PlayerEditing = { key: string; isNew: boolean };
type QuestEditing = { chore: SetupChore; isNew: boolean };

function SetupFlow({
  initial,
  library,
  currency,
  onFinishing,
  onFailed,
  onFinished,
}: {
  initial: SetupDraft;
  library: ChoreLibraryItem[];
  currency: string;
  onFinishing: () => void;
  onFailed: () => void;
  onFinished: (result: SetupResult) => void;
}) {
  const queryClient = useQueryClient();
  const { draft, setDraft, saveError, discard } = useSetupDraft(initial);
  const [editingPlayer, setEditingPlayer] = useState<PlayerEditing | null>(null);
  const [editingQuest, setEditingQuest] = useState<QuestEditing | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const timeZone = browserTimeZone();

  const stageIndex = SETUP_STAGES.indexOf(draft.stage);
  const goTo = (index: number) => {
    const stage = SETUP_STAGES[index]!;
    setDraft((d) => ({ ...d, stage }));
    if (stage === 'masters' && index > stageIndex) sound.fanfare();
    else if (index > stageIndex) sound.pop();
    else sound.tap();
  };

  const mastersProblem = gameMastersProblem(draft.parentNames.map((name) => ({ name })));

  const finish = useMutation({
    mutationFn: () =>
      api.finishSetup({
        parents: draft.parentNames.map((name) => ({ name: name.trim() })),
        children: draft.children,
        chores: draft.chores,
        centsPerPoint: draft.centsPerPoint,
        timezone: timeZone,
      }),
    onMutate: () => {
      // No more draft saves: the server deletes the draft when setup completes.
      discard();
      onFinishing();
    },
    onSuccess: (result) => {
      forgetSetupToken();
      sound.fanfare();
      celebrate({ count: 180, y: 0.55 });
      // Set it now, so /kiosk and /parent don't bounce back here on a stale "needed".
      queryClient.setQueryData<SetupStatus>(['setup-status'], (s) => s && { ...s, needed: false });
      void queryClient.invalidateQueries({
        predicate: (q) => !SETUP_ONLY_QUERIES.includes(String(q.queryKey[0])),
      });
      onFinished(result);
    },
    onError: (err) => {
      onFailed();
      if (err instanceof ApiError && err.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['setup-status'] });
      }
    },
  });

  const startGame = () => {
    if (mastersProblem) {
      setNotice('Give each grown-up a different name first.');
      goTo(SETUP_STAGES.indexOf('masters'));
      return;
    }
    finish.mutate();
  };

  const children = draft.children;
  const selected = children.find((c) => c.key === selectedKey) ?? children[0];

  // --- per-stage content -----------------------------------------------------
  let heading = '';
  let lead = '';
  let body;
  let footer;

  switch (draft.stage) {
    case 'title':
      body = <TitleStage />;
      footer = <ArcadeButton onClick={() => goTo(1)}>▶ START</ArcadeButton>;
      break;

    case 'masters':
      heading = 'GAME MASTERS';
      lead = 'The grown-ups. Each one pairs their phone to check chores and run the board.';
      body = (
        <>
          {notice && <div className={classes.notice}>{notice}</div>}
          <MastersStage
            names={draft.parentNames}
            duplicateName={mastersProblem === 'duplicate-name'}
            canAdd={draft.parentNames.length < MAX_PARENTS}
            onName={(i, name) =>
              setDraft((d) => ({
                ...d,
                parentNames: d.parentNames.map((n, j) => (j === i ? name : n)),
              }))
            }
            onAdd={() => {
              setDraft((d) => ({ ...d, parentNames: [...d.parentNames, ''] }));
              sound.tap();
            }}
            onRemove={(i) => {
              setDraft((d) => ({ ...d, parentNames: d.parentNames.filter((_, j) => j !== i) }));
              sound.tap();
            }}
          />
        </>
      );
      footer = (
        <ArcadeButton
          disabled={mastersProblem !== null}
          onClick={() => {
            setNotice(null);
            goTo(2);
          }}
        >
          NEXT ▶
        </ArcadeButton>
      );
      break;

    case 'players':
      heading = 'PLAYER SELECT';
      lead =
        'Create a player for each child. Their character and colour are how they’ll spot themselves on the board.';
      body = (
        <PlayersStage
          players={children}
          onEdit={(key) => setEditingPlayer({ key, isNew: false })}
          onAdd={() => setEditingPlayer({ key: newKey('p'), isNew: true })}
        />
      );
      footer = (
        <ArcadeButton disabled={children.length === 0} onClick={() => goTo(3)}>
          {children.length
            ? `NEXT ▶ ${children.length} PLAYER${children.length > 1 ? 'S' : ''}`
            : 'ADD A PLAYER FIRST'}
        </ArcadeButton>
      );
      break;

    case 'quests':
      heading = 'HAND OUT QUESTS';
      lead =
        'Pick a player, then tap quests to give them to that player. Tap again to take one away.';
      body = selected && (
        <QuestsStage
          players={children}
          selected={selected}
          chores={draft.chores}
          library={library}
          onSelect={setSelectedKey}
          onToggle={(tile) => {
            const had = draft.chores.some(
              (c) =>
                c.key === (typeof tile === 'string' ? tile : `lib:${tile.id}`) &&
                c.childKeys.includes(selected.key),
            );
            setDraft((d) => ({ ...d, chores: toggleQuestForPlayer(d.chores, tile, selected.key) }));
            if (had) sound.tap();
            else sound.coin();
          }}
          onMakeOwn={() => setEditingQuest({ chore: newChore(selected.key), isNew: true })}
        />
      );
      footer = (
        <ArcadeButton disabled={draft.chores.length === 0} onClick={() => goTo(4)}>
          {draft.chores.length ? `NEXT ▶ ${draft.chores.length} QUESTS` : 'HAND OUT A QUEST FIRST'}
        </ArcadeButton>
      );
      break;

    case 'board': {
      const today = zonedDateOf(now, timeZone);
      heading = 'TODAY’S BOARD';
      lead =
        'Here’s how today looks. Tap a quest to adjust its times and points. Then set what a point is worth.';
      body = (
        <BoardStage
          today={today}
          now={now}
          timeZone={timeZone}
          chores={draft.chores}
          players={children}
          centsPerPoint={draft.centsPerPoint}
          currency={currency}
          onEdit={(key) => {
            const chore = draft.chores.find((c) => c.key === key);
            if (chore) setEditingQuest({ chore, isNew: false });
          }}
          onRate={(centsPerPoint) => setDraft((d) => ({ ...d, centsPerPoint }))}
        />
      );
      footer = (
        <>
          {finish.error && <p className={classes.error}>{finishError(finish.error)}</p>}
          <ArcadeButton tone="green" disabled={finish.isPending} onClick={startGame}>
            {finish.isPending ? 'STARTING…' : '▶ START THE GAME'}
          </ArcadeButton>
        </>
      );
      break;
    }
  }

  const editingPlayerData = editingPlayer && children.find((c) => c.key === editingPlayer.key);

  return (
    <div className={classes.shell}>
      {draft.stage !== 'title' && (
        <>
          <div className={classes.stageBar}>
            <button type="button" aria-label="Back" onClick={() => goTo(stageIndex - 1)}>
              ‹
            </button>
            <div className={classes.pips}>
              {[1, 2, 3, 4].map((n) => (
                <i key={n} data-on={n <= stageIndex || undefined} />
              ))}
            </div>
            <span className="pixel">{stageIndex}/4</span>
          </div>
          <h2 className={classes.heading}>{heading}</h2>
          <p className={classes.lead}>{lead}</p>
        </>
      )}
      <div key={draft.stage} className={classes.body}>
        {body}
      </div>
      <div className={classes.foot}>
        {saveError && (
          <p className={classes.error}>Can’t reach the family PC. Your changes will retry.</p>
        )}
        {footer}
      </div>

      {editingPlayer && (
        <PlayerEditor
          key={editingPlayer.key}
          opened
          isNew={editingPlayer.isNew}
          player={
            editingPlayerData ?? {
              name: '',
              age: DEFAULT_CHILD_AGE,
              ...nextPlayerLook(children),
            }
          }
          takenNames={children.filter((c) => c.key !== editingPlayer.key).map((c) => c.name)}
          onClose={() => setEditingPlayer(null)}
          onSave={(player) => {
            const saved: SetupChild = { ...player, key: editingPlayer.key };
            setDraft((d) => ({
              ...d,
              children: editingPlayer.isNew
                ? [...d.children, saved]
                : d.children.map((c) => (c.key === saved.key ? saved : c)),
            }));
            setEditingPlayer(null);
          }}
          onRemove={
            editingPlayer.isNew
              ? undefined
              : () => {
                  setDraft((d) => removePlayerFromDraft(d, editingPlayer.key));
                  setEditingPlayer(null);
                }
          }
        />
      )}

      {editingQuest && (
        <QuestEditor
          key={editingQuest.chore.key}
          opened
          chore={editingQuest.chore}
          isNew={editingQuest.isNew}
          players={children}
          centsPerPoint={draft.centsPerPoint}
          currency={currency}
          onClose={() => setEditingQuest(null)}
          onSave={(chore) => {
            setDraft((d) => ({
              ...d,
              chores: editingQuest.isNew
                ? [...d.chores, chore]
                : d.chores.map((c) => (c.key === chore.key ? chore : c)),
            }));
            setEditingQuest(null);
          }}
          onDelete={
            editingQuest.isNew
              ? undefined
              : () => {
                  setDraft((d) => ({
                    ...d,
                    chores: d.chores.filter((c) => c.key !== editingQuest.chore.key),
                  }));
                  setEditingQuest(null);
                }
          }
        />
      )}
    </div>
  );
}

function finishError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'setup-token') {
      return 'This setup link has expired. Scan the code on the family PC again.';
    }
    if (err.status === 409) return 'Setup was already finished on another device.';
    if (err.status === 400) return 'Something doesn’t look right. Check the grown-ups and quests.';
  }
  return 'Couldn’t reach the family PC. Check the Wi-Fi and try again.';
}
