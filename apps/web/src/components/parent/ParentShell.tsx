import type { SetupChore } from '@pmp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useLiveEvents } from '../../lib/live-events';
import { useMuted } from '../../lib/parent-prefs';
import { askedPush, enablePush, pushState, registerServiceWorker, resyncPush } from '../../lib/pwa';
import { preloadSounds, sound } from '../../lib/sounds';
import { ArcadeButton, Sheet } from '../arcade';
import { NewQuestPicker } from './NewQuestPicker';
import { DayTab } from './DayTab';
import {
  ParentUiContext,
  problemText,
  useDay,
  useParentUi,
  useTray,
  type Banner,
  type ParentUi,
} from './context';
import classes from './parent.module.css';
import { PhoneQuestEditor, type EditorTarget } from './PhoneQuestEditor';
import { PaydayTab } from './money/PaydayTab';
import { PlayersTab } from './PlayersTab';
import { SurprisePanel } from './SurprisePanel';
import { SurpriseSheet } from './Surprises';
import { Tray } from './Tray';
import { WeekTab } from './WeekTab';
import {
  formatMoney,
  surpriseBanner,
  type DayPlan,
  type MoneyOverview,
  type ServerEvent,
  type SurpriseRun,
} from '@pmp/shared';

type Tab = 'day' | 'week' | 'players' | 'payday';
const TABS: { key: Tab; label: string }[] = [
  { key: 'day', label: '🕒 Day' },
  { key: 'week', label: '📅 Week' },
  { key: 'players', label: '🎮 Players' },
  { key: 'payday', label: '💰 Payday' },
];

const BANNER_MS = 4500;
const FLASH_MS = 1500;
/** A team's claims arrive together: one "done" banner for them. */
const SAME_MOMENT_MS = 2000;

/**
 * The parent phone (spec 003): Day / Week / Players tabs with no header above them, the
 * to-check tray pinned to the bottom, and an in-app banner when a child claims a chore.
 */
export function ParentShell({ welcome }: { welcome: Banner | null }) {
  useMuted();
  useEffect(preloadSounds, []);
  const queryClient = useQueryClient();
  const { subscribe } = useLiveEvents();
  const tray = useTray();
  // A money notification opens /parent?tab=payday (spec 004).
  const [tab, setTab] = useState<Tab>(() => tabFromUrl());
  // A claim notification opens /parent?tray=1 (spec 003, "Notifications").
  const [trayOpen, setTrayOpen] = useState(() => openTrayFromUrl());
  const [banner, setBanner] = useState<(Banner & { id: number }) | null>(
    welcome && { ...welcome, id: 0 },
  );
  const [flash, setFlash] = useState<number | null>(null);
  const [editing, setEditing] = useState<(EditorTarget & { id: number }) | null>(null);
  const [picking, setPicking] = useState<{ offerOneOff: boolean; childId?: number } | null>(null);
  // Surprise quests (spec 006): the panel, a row's sheet, and the row that just changed.
  const [panel, setPanel] = useState<{ id: number; scheduled: SurpriseRun | null } | null>(null);
  const [surpriseSheet, setSurpriseSheet] = useState<number | null>(null);
  const [flashRun, setFlashRun] = useState<number | null>(null);
  const today = useDay('today');
  const nextId = useRef(1);

  const notify = useCallback((b: Banner) => setBanner({ ...b, id: nextId.current++ }), []);
  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(null), BANNER_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  const ui: ParentUi = useMemo(
    () => ({
      notify,
      openQuest: (choreId) => {
        sound.tap();
        setEditing({ choreId, id: nextId.current++ });
      },
      newQuest: (options) => {
        sound.tap();
        setPicking(options);
      },
      openTray: () => setTrayOpen(true),
      newSurprise: (scheduled) => setPanel({ id: nextId.current++, scheduled: scheduled ?? null }),
      openSurprise: (runId) => setSurpriseSheet(runId),
      flashSurprise: (runId) => {
        setFlashRun(runId);
        setTimeout(() => setFlashRun((r) => (r === runId ? null : r)), FLASH_MS);
      },
    }),
    [notify],
  );

  // A child claimed a chore: the banner slides down, the badge pops, the row flashes.
  const lastDone = useRef<{ runId: number; at: number } | null>(null);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== 'instance.claimed') return;
        const { claim } = event;
        const plan = queryClient.getQueryData<DayPlan>(['day', 'today']);
        const child = plan?.children.find((c) => c.id === claim.childId);
        // A surprise's "done" (spec 006): one banner for a team, naming everyone on it.
        const run = queryClient
          .getQueryData<SurpriseRun[]>(['surprises', 'today'])
          ?.find((r) => r.takers.some((t) => t.instanceId === claim.instanceId));
        if (run) {
          const last = lastDone.current;
          lastDone.current = { runId: run.id, at: Date.now() };
          if (last?.runId === run.id && Date.now() - last.at < SAME_MOMENT_MS) return;
          const names = run.takers.map(
            (t) => plan?.children.find((c) => c.id === t.childId)?.name ?? 'Someone',
          );
          sound.pop();
          notify({
            ...surpriseBanner({
              kind: 'done',
              title: run.title,
              names: run.team ? names : [child?.name ?? 'Someone'],
              avatar: child?.avatar ?? '🙋',
            }),
            onClick: () => setTrayOpen(true),
          });
          ui.flashSurprise(run.id);
          return;
        }
        const quest = plan?.quests.find((q) => q.instances.some((i) => i.id === claim.instanceId));
        sound.pop();
        notify({
          icon: child?.avatar ?? '🙋',
          title: `${child?.name ?? 'Someone'} claimed ${quest ? `‘${quest.chore.title}’` : 'a quest'}`,
          body: 'Swipe it in the tray to approve',
          onClick: () => setTrayOpen(true),
        });
        if (quest) {
          setFlash(quest.chore.id);
          setTimeout(() => setFlash(null), FLASH_MS);
        }
      }),
    [subscribe, queryClient, notify, ui],
  );

  // Surprise moments (spec 006): grabbed, nobody grabbed it, a scheduled one popped up.
  useEffect(
    () =>
      subscribe((event) => {
        const plan = queryClient.getQueryData<DayPlan>(['day', 'today']);
        const childOf = (id: number) => plan?.children.find((c) => c.id === id);
        let banner: Banner | null = null;
        if (event.type === 'surprise.grabbed') {
          const { run } = event;
          const ms =
            run.grabbedAt !== null && run.shownAt !== null ? run.grabbedAt - run.shownAt : null;
          const taker = childOf(event.childIds[0] ?? 0);
          banner = event.team
            ? surpriseBanner({
                kind: 'team',
                title: run.title,
                names: event.childIds.map((id) => childOf(id)?.name ?? 'Someone'),
                reward: run.rewardPoints,
              })
            : surpriseBanner({
                kind: 'grabbed',
                title: run.title,
                taker: { name: taker?.name ?? 'Someone', avatar: taker?.avatar ?? '⚡' },
                ms,
              });
        } else if (event.type === 'surprise.expired') {
          banner = surpriseBanner({ kind: 'expired', title: event.run.title });
        } else if (event.type === 'surprise.live' && event.run.appearAt !== null) {
          banner = surpriseBanner({ kind: 'appeared', title: event.run.title });
        }
        if (!banner || !('run' in event)) return;
        const runId = event.run.id;
        sound.pop();
        notify({ ...banner, onClick: () => setSurpriseSheet(runId) });
        ui.flashSurprise(runId);
      }),
    [subscribe, queryClient, notify, ui],
  );

  // Money moments a parent should hear about (spec 004, ADR 0010): banners only; the
  // smashed jar and "payday is ready" are also pushed to phones that aren't open.
  useEffect(
    () =>
      subscribe((event) => {
        const show = (banner: Banner | null) => {
          if (!banner) return;
          sound.pop();
          notify({ ...banner, onClick: () => setTab('payday') });
        };
        if (event.type === 'goal.created' && event.byChild) {
          // The new jar isn't on this phone yet: fetch it, to say what and how much.
          void api.money().then(
            (money) => show(moneyBanner(event, money)),
            () => undefined,
          );
          return;
        }
        show(moneyBanner(event, queryClient.getQueryData<MoneyOverview>(['money'])));
      }),
    [subscribe, queryClient, notify],
  );

  // The service worker (HTTPS only): a tapped notification while the app is open says so.
  useEffect(() => {
    registerServiceWorker();
    void resyncPush().catch(() => undefined);
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'open-tray') setTrayOpen(true);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  const items = tray.data ?? [];
  const pickDraft = (draft: SetupChore) => {
    setPicking(null);
    setEditing({ draft, id: nextId.current++ });
  };

  return (
    <ParentUiContext.Provider value={ui}>
      <div className={classes.app}>
        <nav className={classes.tabs}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              data-on={tab === t.key || undefined}
              onClick={() => {
                setTab(t.key);
                sound.tap();
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <main className={classes.main} data-tray={items.length > 0 || undefined}>
          {tab === 'day' && <DayTab flashChoreId={flash} flashRunId={flashRun} />}
          {tab === 'week' && <WeekTab />}
          {tab === 'players' && <PlayersTab />}
          {tab === 'payday' && <PaydayTab />}
        </main>
        <Tray
          items={items}
          open={trayOpen}
          onToggle={() => {
            setTrayOpen((o) => !o);
            sound.tap();
          }}
        />
      </div>

      <AnimatePresence>
        {banner && (
          <motion.button
            key={banner.id}
            type="button"
            className={classes.banner}
            data-tone={banner.tone}
            initial={{ y: -120, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -120, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            onClick={() => {
              banner.onClick?.();
              setBanner(null);
            }}
          >
            <span className={classes.bannerIcon}>{banner.icon}</span>
            <span>
              <b>{banner.title}</b>
              {banner.body && <small>{banner.body}</small>}
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {picking && (
        <NewQuestPicker
          opened
          offerOneOff={picking.offerOneOff}
          childId={picking.childId}
          onPick={pickDraft}
          onClose={() => setPicking(null)}
        />
      )}
      {editing && (
        <PhoneQuestEditor key={editing.id} target={editing} onClose={() => setEditing(null)} />
      )}
      {panel && (
        <SurprisePanel key={panel.id} scheduled={panel.scheduled} onClose={() => setPanel(null)} />
      )}
      {surpriseSheet !== null && today.data && (
        <SurpriseSheet
          runId={surpriseSheet}
          kids={today.data.children}
          clockOffsetMs={today.data.clockOffsetMs}
          onClose={() => setSurpriseSheet(null)}
        />
      )}
      <PushOptIn />
    </ParentUiContext.Provider>
  );
}

/** `?tab=payday` opens that tab (a money notification), then leaves the address. */
function tabFromUrl(): Tab {
  const url = new URL(location.href);
  const tab = url.searchParams.get('tab');
  if (!tab) return 'day';
  url.searchParams.delete('tab');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  return TABS.some((t) => t.key === tab) ? (tab as Tab) : 'day';
}

/** The banner for a money event, or null when it isn't one a parent needs to see. */
function moneyBanner(event: ServerEvent, money: MoneyOverview | undefined): Banner | null {
  const childOf = (id: number) => money?.children.find((c) => c.id === id);
  const jarOf = (childId: number, goalId: number) =>
    childOf(childId)?.jars.find((j) => j.id === goalId);
  switch (event.type) {
    case 'goal.created': {
      if (!event.byChild) return null;
      const child = childOf(event.childId);
      const jar = jarOf(event.childId, event.goalId);
      return {
        icon: jar?.emoji ?? child?.avatar ?? '🍯',
        title:
          jar && money
            ? `${child?.name ?? 'A player'} made a jar: ${jar.name}, ${formatMoney(jar.targetCents, money.currency)}`
            : `${child?.name ?? 'A player'} made a jar`,
        body: 'Tap to check the price.',
      };
    }
    case 'goal.deleted': {
      if (!event.byChild) return null;
      const jar = jarOf(event.childId, event.goalId);
      return {
        icon: '🗑',
        title: `${childOf(event.childId)?.name ?? 'A player'} deleted the ${jar?.name ?? ''} jar`,
        body: jar && jar.inCents > 0 ? 'Its coins went back to “to sort”.' : undefined,
      };
    }
    case 'goal.smashed': {
      const jar = jarOf(event.childId, event.goalId);
      return {
        icon: '🔨',
        title: `${childOf(event.childId)?.name ?? 'A player'} smashed the ${jar?.name ?? ''} jar`,
        body:
          jar && money
            ? `${formatMoney(jar.inCents, money.currency)} ready · needs buying`
            : undefined,
      };
    }
    case 'envelope.opened': {
      const child = childOf(event.childId);
      const envelope = child?.envelopes.find((e) => e.id === event.envelopeId);
      return {
        icon: '💌',
        title: `${child?.name ?? 'A player'} opened ${envelope ? `the envelope from ${envelope.fromName}` : 'an envelope'}`,
      };
    }
    case 'payday.waiting':
      return { icon: '💰', title: 'It’s payday!', body: 'Start it when the kids are ready.' };
    default:
      return null;
  }
}

/** `?tray=1` opens the tray, and is taken off the address so a reload doesn't repeat it. */
function openTrayFromUrl(): boolean {
  const url = new URL(location.href);
  if (url.searchParams.get('tray') !== '1') return false;
  url.searchParams.delete('tray');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  return true;
}

/**
 * After pairing, over HTTPS: "Notify this phone about claimed chores?" once per phone
 * (spec 003). Either answer is final here; the Players tab has the switch afterwards.
 */
function PushOptIn() {
  const ui = useParentUi();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (askedPush()[0]) return;
    const timer = setTimeout(() => {
      void pushState().then((state) => setOpen(state === 'off'));
    }, 1500);
    return () => clearTimeout(timer);
  }, []);
  if (!open) return null;
  const close = () => {
    askedPush()[1]();
    setOpen(false);
  };
  return (
    <Sheet
      opened
      short
      onClose={close}
      head={<span className={classes.sheetTitle}>🔔 Notifications</span>}
      footer={
        <div className={classes.optInButtons}>
          <ArcadeButton
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const state = await enablePush();
                if (state === 'on') {
                  sound.coin();
                  ui.notify({ icon: '🔔', title: 'Notifications are on', body: 'For this phone.' });
                }
              } catch (err) {
                ui.notify({
                  icon: '⚠️',
                  title: 'Notifications not on',
                  body: problemText(err),
                  tone: 'error',
                });
              } finally {
                close();
              }
            }}
          >
            Yes, notify this phone
          </ArcadeButton>
          <ArcadeButton tone="ghost" size="small" onClick={close}>
            Not now
          </ArcadeButton>
        </div>
      }
    >
      <p className={classes.centre}>
        Get a notification on this phone when a child claims a chore? Quiet hours are respected, and
        you can change this on the Players tab.
      </p>
    </Sheet>
  );
}
