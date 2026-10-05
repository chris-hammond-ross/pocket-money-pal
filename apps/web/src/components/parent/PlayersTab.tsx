import { Switch } from '@mantine/core';
import {
  BONUS_STEPS,
  CURRENCIES,
  DEFAULT_CURRENCY,
  DEFAULT_CHILD_AGE,
  DEFAULT_QUIET_HOURS,
  FACTORY_RESET_WORD,
  formatMoney,
  formatPairingCode,
  formatPointsChange,
  nextPlayerLook,
  PAIRING_CODE_MINUTES,
  type ChildInput,
  type CurrencyCode,
  type DeviceList,
  type PlayerCard,
  type QuietHours,
} from '@pmp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../lib/api';
import { clockTime, formatMinutesAgo } from '../../lib/format';
import { useMuted } from '../../lib/parent-prefs';
import {
  canPush,
  disablePush,
  enablePush,
  installHintDismissed,
  isSecure,
  isStandalone,
  pushState,
  useInstallPrompt,
  type PushState,
} from '../../lib/pwa';
import { pairUrl, phoneBaseUrls, useQrSvg } from '../../lib/qr';
import { rememberSetupToken } from '../../lib/setup-token';
import { sound } from '../../lib/sounds';
import { ArcadeButton, CloseButton, DashedButton, PixelLabel, RateSlider, Sheet } from '../arcade';
import { Flame, flameColours } from '../Flame';
import { PlayerEditor } from '../PlayerEditor';
import { problemText, useParentUi, usePlayers } from './context';
import classes from './parent.module.css';

/** Where the plain-HTTP hint sends a parent: the install guide's Tailscale section. */
export const SECURE_ACCESS_GUIDE =
  'https://github.com/chris-hammond-ross/pocket-money-pal/blob/main/installation.md#secure-access-with-tailscale';

/**
 * The Players tab (spec 003): player cards (with their streak and a sick-day button, spec
 * 005) and the player editor, game masters, paired phones, the loot rate and bonus points;
 * then notifications, quiet hours and the kiosk's volume, this phone's sounds, and the
 * factory reset. Over HTTPS it offers "📲 Install"; over plain HTTP, a one-time hint.
 */
export function PlayersTab() {
  const [muted, setMuted] = useMuted();
  const [inviting, setInviting] = useState(false);
  return (
    <>
      <InstallCard />

      <PixelLabel>PLAYERS</PixelLabel>
      <Players />

      <PixelLabel>GAME MASTERS</PixelLabel>
      <GameMasters />

      <PixelLabel>PAIRED PHONES</PixelLabel>
      <PairedPhones />
      <ArcadeButton tone="ghost" size="small" onClick={() => setInviting(true)}>
        📱 Pair another phone
      </ArcadeButton>

      <PixelLabel>LOOT RATE</PixelLabel>
      <CurrencyRow />
      <LootRate />

      <PixelLabel>BONUS POINTS</PixelLabel>
      <BonusPoints />

      <PixelLabel>NOTIFICATIONS</PixelLabel>
      <PushRow />
      <QuietHoursRow />
      <KioskVolume />

      <PixelLabel>THIS PHONE</PixelLabel>
      <label className={classes.toggleRow}>
        <span>🔊 Sounds</span>
        <Switch
          color="gold"
          checked={!muted}
          onChange={(e) => {
            setMuted(!e.currentTarget.checked);
            if (e.currentTarget.checked) sound.coin();
          }}
        />
      </label>
      <SwitchToSecure />

      <PixelLabel>DANGER ZONE</PixelLabel>
      <FactoryReset />
      <AppVersion />

      {inviting && <InviteSheet onClose={() => setInviting(false)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Installing (ADR 0002, ADR 0009)

/**
 * Over HTTPS, "📲 Install" when Chrome offers it. Over plain HTTP, a one-time dismissible
 * hint, with "🔒 Switch to secure app" when the server knows its HTTPS address.
 */
function InstallCard() {
  const install = useInstallPrompt();
  const [dismissed, setDismissed] = useState(() => installHintDismissed()[0]);

  if (isSecure()) {
    if (!install || isStandalone()) return null;
    return (
      <div className={classes.hintCard}>
        <span className={classes.rowIcon}>🐷</span>
        <div className={classes.grow}>
          <b>Install as an app</b>
          <small>Its own icon, no address bar, and notifications.</small>
        </div>
        <button
          type="button"
          className={classes.pill}
          onClick={() => {
            sound.tap();
            void install().then((ok) => ok && sound.fanfare());
          }}
        >
          📲 Install
        </button>
      </div>
    );
  }

  if (dismissed) return null;
  return (
    <div className={classes.hintCard}>
      <span className={classes.rowIcon}>📲</span>
      <div className={classes.grow}>
        <b>Install as an app</b>
        <small>
          Set up secure access (Tailscale) to install this as an app and get notifications.{' '}
          <a href={SECURE_ACCESS_GUIDE} target="_blank" rel="noreferrer">
            How?
          </a>
        </small>
        <SwitchToSecure />
      </div>
      <CloseButton
        onClick={() => {
          installHintDismissed()[1]();
          setDismissed(true);
        }}
      />
    </div>
  );
}

/**
 * "🔒 Switch to secure app" (ADR 0009): over plain HTTP, when the server knows its HTTPS
 * address. A move code opens the pair screen there, and pairing with it unpairs this tab.
 */
function SwitchToSecure() {
  const ui = useParentUi();
  const secure = isSecure();
  const access = useQuery({ queryKey: ['access'], queryFn: api.access, enabled: !secure });
  const secureUrl = access.data?.secureUrl;
  const move = useMutation({
    mutationFn: () => api.invite(true),
    onSuccess: (invite) => {
      if (secureUrl) location.href = pairUrl(secureUrl, invite.code);
    },
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Couldn’t switch', body: problemText(err), tone: 'error' }),
  });
  if (secure || !secureUrl) return null;
  return (
    <ArcadeButton
      tone="ghost"
      size="small"
      className={classes.secureButton}
      disabled={move.isPending}
      onClick={() => {
        sound.tap();
        move.mutate();
      }}
    >
      🔒 Switch to secure app
    </ArcadeButton>
  );
}

// ---------------------------------------------------------------------------
// Players and game masters

type Editing = { player: PlayerCard | null };

function Players() {
  const ui = useParentUi();
  const queryClient = useQueryClient();
  const players = usePlayers();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const currency = settings.data?.currency ?? DEFAULT_CURRENCY;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [sickFor, setSickFor] = useState<PlayerCard | null>(null);

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['players'] });
    setEditing(null);
  };
  const fail = (title: string) => (err: unknown) => {
    sound.sad();
    ui.notify({ icon: '⚠️', title, body: problemText(err), tone: 'error' });
  };
  const create = useMutation({
    mutationFn: api.createPlayer,
    onSuccess: done,
    onError: fail('Player not added'),
  });
  const update = useMutation({
    mutationFn: ({ id, child }: { id: number; child: ChildInput }) => api.updatePlayer(id, child),
    onSuccess: done,
    onError: fail('Not saved'),
  });
  const remove = useMutation({
    mutationFn: (player: PlayerCard) => api.removePlayer(player.id),
    onSuccess: ({ questsLeftEmpty }, player) => {
      done();
      const empty = questsLeftEmpty.length;
      ui.notify({
        icon: player.avatar,
        title: `${player.name} has left the game`,
        body:
          empty === 0
            ? 'Their quests are off the board.'
            : `${empty} quest${empty === 1 ? ' has' : 's have'} no players now. Add someone in the quest editor.`,
      });
    },
    onError: fail('Not removed'),
  });
  const sick = useMutation({
    mutationFn: ({ player, on }: { player: PlayerCard; on: boolean }) =>
      api.sickToday(player.id, on),
    onSuccess: (_card, { player, on }) => {
      void queryClient.invalidateQueries({ queryKey: ['players'] });
      setSickFor(null);
      sound.pop();
      ui.notify({
        icon: on ? '🤒' : player.avatar,
        title: on ? `Get well soon, ${player.name}` : `${player.name}'s quests are back`,
        body: on
          ? "Today's quests are skipped, so the streak is safe."
          : 'They’re on the kiosk again.',
      });
    },
    onError: fail('Not changed'),
  });

  const list = players.data ?? [];
  const editingPlayer = editing?.player ?? null;
  const editorPlayer: ChildInput = editingPlayer
    ? {
        name: editingPlayer.name,
        age: editingPlayer.age ?? DEFAULT_CHILD_AGE,
        avatar: editingPlayer.avatar,
        colour: editingPlayer.colour,
      }
    : { name: '', age: DEFAULT_CHILD_AGE, ...nextPlayerLook(list) };

  return (
    <>
      {list.map((p) => (
        <div key={p.id} className={classes.pcardRow}>
          <button
            type="button"
            className={classes.pcard}
            style={{ '--c': p.colour } as CSSProperties}
            onClick={() => {
              sound.tap();
              setEditing({ player: p });
            }}
          >
            <span className={classes.pcardAvatar}>{p.avatar}</span>
            <span className={classes.grow}>
              <b>{p.name}</b>
              <small>
                {p.age !== null && `Age ${p.age} · `}
                <span
                  className={classes.pcardStreak}
                  style={{ color: flameColours(p.streak.tier).text }}
                  title={`Best ever: ${p.streak.best}`}
                >
                  <Flame tier={p.streak.tier} className={classes.pcardFlame} />
                  {p.streak.days} day streak
                </span>{' '}
                · {p.quests} {p.quests === 1 ? 'quest' : 'quests'}
              </small>
              <small>
                {p.sickToday ? (
                  '🤒 Sick day: today’s quests are skipped'
                ) : (
                  <>
                    <em>{p.pointsToday} pts</em> today · <em>{formatMoney(p.cents, currency)}</em>{' '}
                    saved
                  </>
                )}
              </small>
            </span>
          </button>
          <button
            type="button"
            className={classes.sickButton}
            data-on={p.sickToday || undefined}
            disabled={sick.isPending}
            onClick={() => {
              sound.tap();
              if (p.sickToday) sick.mutate({ player: p, on: false });
              else setSickFor(p);
            }}
          >
            <span>🤒</span>
            <small>{p.sickToday ? 'Undo' : 'Sick day'}</small>
          </button>
        </div>
      ))}
      <DashedButton
        onClick={() => {
          sound.tap();
          setEditing({ player: null });
        }}
      >
        ＋ New player
      </DashedButton>

      {sickFor && (
        <Sheet
          opened
          short
          colour={sickFor.colour}
          onClose={() => setSickFor(null)}
          head={
            <>
              <span className={classes.sheetTitle}>🤒 Sick day for {sickFor.name}?</span>
              <CloseButton onClick={() => setSickFor(null)} />
            </>
          }
          footer={
            <ArcadeButton
              disabled={sick.isPending}
              onClick={() => sick.mutate({ player: sickFor, on: true })}
            >
              🤒 Skip all of {sickFor.name}’s quests today
            </ArcadeButton>
          }
        >
          <p className={classes.note}>
            Today’s quests leave the kiosk, so {sickFor.name}’s{' '}
            {sickFor.streak.days > 0 ? `${sickFor.streak.days}-day streak` : 'streak'} is safe.
            Anything already claimed still waits for you to check. You can undo it today.
          </p>
        </Sheet>
      )}

      {editing && (
        <PlayerEditor
          opened
          isNew={editingPlayer === null}
          player={editorPlayer}
          takenNames={list.filter((p) => p.id !== editingPlayer?.id).map((p) => p.name)}
          onSave={(child) =>
            editingPlayer ? update.mutate({ id: editingPlayer.id, child }) : create.mutate(child)
          }
          onRemove={editingPlayer ? () => remove.mutate(editingPlayer) : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function GameMasters() {
  const masters = useQuery({ queryKey: ['game-masters'], queryFn: api.gameMasters });
  return (
    <>
      {(masters.data ?? []).map((m) => (
        <div key={m.id} className={classes.row}>
          <span className={classes.rowIcon}>🧙</span>
          <div className={classes.grow}>
            <b>{m.name}</b>
            <small>
              {m.phones === 0
                ? 'No phone paired'
                : `${m.phones} phone${m.phones === 1 ? '' : 's'} paired`}
            </small>
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Loot rate and bonus points

/** The family's money symbol, $ £ or €: every screen switches to it at once. */
function CurrencyRow() {
  const ui = useParentUi();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const save = useMutation({
    mutationFn: (currency: CurrencyCode) => api.updateSettings({ currency }),
    onSuccess: () => sound.pop(),
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Currency not saved', body: problemText(err), tone: 'error' }),
  });
  if (!settings.data) return null;
  const current = save.isPending ? save.variables : settings.data.currency;
  return (
    <div className={classes.row}>
      <span>💱 Currency</span>
      <div className={classes.currencyChips}>
        {CURRENCIES.map(({ code, symbol }) => (
          <button
            key={code}
            type="button"
            data-on={current === code || undefined}
            disabled={save.isPending}
            aria-label={code}
            onClick={() => current !== code && save.mutate(code)}
          >
            {symbol}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "1 point = 5p": saved when the slider is let go, and only applies from then on. */
function LootRate() {
  const ui = useParentUi();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [dragging, setDragging] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: (centsPerPoint: number) => api.updateSettings({ centsPerPoint }),
    onSuccess: () => sound.pop(),
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Rate not saved', body: problemText(err), tone: 'error' }),
    onSettled: () => setDragging(null),
  });
  if (!settings.data) return null;
  const saved = settings.data.centsPerPoint;
  return (
    <>
      <RateSlider
        value={dragging ?? saved}
        currency={settings.data.currency}
        onChange={(cents) => {
          setDragging(cents);
          sound.tick();
        }}
        onCommit={() => {
          if (dragging !== null && dragging !== saved) save.mutate(dragging);
          else setDragging(null);
        }}
      />
      <p className={classes.note}>
        A new rate only counts from now on. Points already earned keep their value.
      </p>
    </>
  );
}

function BonusPoints() {
  const ui = useParentUi();
  const players = usePlayers();
  const adjust = useMutation({
    mutationFn: ({ id, points }: { id: number; points: number; name: string }) =>
      api.adjustPoints(id, points),
    onSuccess: (_, { points, name }) => {
      if (points > 0) sound.coin();
      else sound.sad();
      ui.notify({
        icon: points > 0 ? '⭐' : '🥀',
        title: `${name} ${formatPointsChange(points)} points`,
      });
    },
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Not given', body: problemText(err), tone: 'error' }),
  });
  return (
    <>
      {(players.data ?? []).map((p) => (
        <div key={p.id} className={classes.row}>
          <span className={classes.rowIcon}>{p.avatar}</span>
          <div className={classes.grow}>
            <b>{p.name}</b>
            <small>{p.pointsToday} pts today</small>
          </div>
          {BONUS_STEPS.map((points) => (
            <button
              key={points}
              type="button"
              className={classes.bonus}
              data-minus={points < 0 || undefined}
              disabled={adjust.isPending}
              onClick={() => adjust.mutate({ id: p.id, points, name: p.name })}
            >
              {formatPointsChange(points)}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Notifications: push on this phone, quiet hours for the family

function PushRow() {
  const ui = useParentUi();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushState().then(setState);
  }, []);

  if (!canPush()) {
    return (
      <div className={classes.row}>
        <span className={classes.rowIcon}>🔕</span>
        <div className={classes.grow}>
          <b>Notifications</b>
          <small>They need secure access (Tailscale). The tray still shows every claim.</small>
        </div>
      </div>
    );
  }

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      const next = on ? await enablePush() : await disablePush();
      setState(next);
      if (next === 'on') sound.coin();
      if (on && next === 'denied') {
        ui.notify({
          icon: '🔕',
          title: 'Notifications are blocked',
          body: 'Allow them for this site in Chrome’s settings, then try again.',
          tone: 'error',
        });
      }
    } catch (err) {
      ui.notify({
        icon: '⚠️',
        title: 'Notifications not changed',
        body: problemText(err),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const test = async (delaySeconds: number) => {
    sound.tap();
    try {
      await api.testPush(delaySeconds);
      if (delaySeconds > 0) {
        ui.notify({
          icon: '⏱️',
          title: 'A test comes in a minute',
          body: 'Lock the phone and wait.',
        });
      }
    } catch (err) {
      ui.notify({ icon: '⚠️', title: 'Test not sent', body: problemText(err), tone: 'error' });
    }
  };

  return (
    <>
      <label className={classes.toggleRow}>
        <span>
          🔔 Claimed chores on this phone
          {state === 'denied' && (
            <small className={classes.dimLine}>Blocked in Chrome’s settings</small>
          )}
        </span>
        <Switch
          color="gold"
          checked={state === 'on'}
          disabled={busy || state === null}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
      </label>
      {state === 'on' && (
        <div className={classes.testRow}>
          <button type="button" onClick={() => void test(0)}>
            Send a test
          </button>
          <button type="button" onClick={() => void test(60)}>
            Test in 1 minute
          </button>
        </div>
      )}
    </>
  );
}

/** Half-hour choices for quiet hours. */
const HALF_HOURS = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
);

/** Quiet hours, for the whole family: no notifications in this window (ADR 0009). */
function QuietHoursRow() {
  const ui = useParentUi();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const save = useMutation({
    mutationFn: (quietHours: QuietHours | null) => api.updateSettings({ quietHours }),
    onSuccess: () => sound.pop(),
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Not saved', body: problemText(err), tone: 'error' }),
  });
  if (!settings.data) return null;
  const quiet = settings.data.quietHours;
  const choices = (q: QuietHours) => [...new Set([...HALF_HOURS, q.from, q.until])].sort();
  return (
    <>
      <label className={classes.toggleRow}>
        <span>
          🌙 Quiet hours
          <small className={classes.dimLine}>
            {quiet
              ? `No notifications ${clockTime(quiet.from)}–${clockTime(quiet.until)}, on every phone`
              : 'Notifications at any time'}
          </small>
        </span>
        <Switch
          color="gold"
          checked={quiet !== null}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.currentTarget.checked ? DEFAULT_QUIET_HOURS : null)}
        />
      </label>
      {quiet && (
        <div className={classes.quietTimes}>
          {(['from', 'until'] as const).map((end) => (
            <label key={end}>
              <small>{end === 'from' ? 'From' : 'Until'}</small>
              <select
                value={quiet[end]}
                disabled={save.isPending}
                onChange={(e) => {
                  const next = { ...quiet, [end]: e.target.value };
                  if (next.from !== next.until) save.mutate(next);
                }}
              >
                {choices(quiet).map((t) => (
                  <option key={t} value={t}>
                    {clockTime(t)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

/** The kiosk's sound volume (spec 005). Quiet hours mute the kiosk too. */
function KioskVolume() {
  const ui = useParentUi();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [dragging, setDragging] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: (volume: number) => api.updateSettings({ volume }),
    onSuccess: () => sound.pop(),
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Volume not saved', body: problemText(err), tone: 'error' }),
    onSettled: () => setDragging(null),
  });
  if (!settings.data) return null;
  const saved = settings.data.volume;
  const value = dragging ?? saved;
  const commit = () => {
    if (dragging !== null && dragging !== saved) save.mutate(dragging);
    else setDragging(null);
  };
  return (
    <div className={classes.volumeRow}>
      <div className={classes.volumeHead}>
        <span>
          {value === 0 ? '🔇' : '🔊'} Kiosk sounds
          <small className={classes.dimLine}>
            {settings.data.quietHours
              ? 'Silent in quiet hours; animations still play'
              : 'How loud the kiosk plays its sounds'}
          </small>
        </span>
        <b>{value}</b>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        aria-label="Kiosk volume"
        onChange={(e) => setDragging(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paired phones (ADR 0008)

function PairedPhones() {
  const ui = useParentUi();
  const devices = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const [armed, setArmed] = useState<number | null>(null);
  const revoke = useMutation({
    mutationFn: (id: number) => api.revokeDevice(id),
    onSuccess: () => sound.sad(),
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Not revoked', body: problemText(err), tone: 'error' }),
  });

  return (
    <>
      {(devices.data ?? []).map((d) => (
        <div key={d.id} className={classes.row}>
          <span className={classes.rowIcon}>📱</span>
          <div className={classes.grow}>
            <b>
              {d.name} · {d.parent.name}
            </b>
            <small>{d.current ? 'this phone' : lastSeen(d)}</small>
          </div>
          <button
            type="button"
            data-armed={armed === d.id || undefined}
            disabled={revoke.isPending}
            onClick={() => {
              if (armed === d.id) {
                revoke.mutate(d.id);
                setArmed(null);
              } else {
                setArmed(d.id);
                sound.tap();
              }
            }}
          >
            {armed === d.id ? (d.current ? 'Unpair me?' : 'Sure?') : 'Revoke'}
          </button>
        </div>
      ))}
    </>
  );
}

function lastSeen(device: DeviceList[number]): string {
  return device.lastSeenAt === null
    ? 'not used yet'
    : `used ${formatMinutesAgo(device.lastSeenAt)}`;
}

/**
 * "Pair another phone": a one-time QR code (and the code to type), valid for 10 minutes.
 * It notices when a new phone appears in the list and says so.
 */
function InviteSheet({ onClose }: { onClose: () => void }) {
  const devices = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const invite = useMutation({ mutationFn: api.invite });
  const [receivedAt, setReceivedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const queryClient = useQueryClient();
  // The phones paired when the sheet opened (the list above loaded them), to spot a new one.
  const [known] = useState(() => {
    const list = queryClient.getQueryData<DeviceList>(['devices']);
    return list ? new Set(list.map((d) => d.id)) : null;
  });

  const { mutate } = invite;
  useEffect(() => {
    mutate(undefined, { onSuccess: () => setReceivedAt(Date.now()) });
  }, [mutate]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const joined = known && devices.data?.find((d) => !known.has(d.id));
  useEffect(() => {
    if (joined) sound.fanfare();
  }, [joined]);

  const data = invite.data;
  const base = data ? phoneBaseUrls(data, location)[0] : undefined;
  const qr = useQrSvg(data && base ? pairUrl(base, data.code) : null);
  // Counted on this phone's clock from when the code arrived (the server's may be moved).
  const left = data ? Math.max(0, receivedAt + PAIRING_CODE_MINUTES * 60_000 - now) : 0;
  const expired = data !== undefined && left === 0;

  return (
    <Sheet
      opened
      onClose={onClose}
      short
      head={
        <>
          <span className={classes.sheetTitle}>📱 Pair another phone</span>
          <CloseButton onClick={onClose} />
        </>
      }
      footer={
        joined ? (
          <ArcadeButton onClick={onClose}>Done</ArcadeButton>
        ) : (
          expired && (
            <ArcadeButton
              onClick={() => mutate(undefined, { onSuccess: () => setReceivedAt(Date.now()) })}
            >
              New code
            </ArcadeButton>
          )
        )
      }
    >
      {joined ? (
        <p className={classes.centre}>
          ✅ {joined.parent.name}’s {joined.name.toLowerCase()} is paired.
        </p>
      ) : invite.error ? (
        <p className={classes.error}>{problemText(invite.error)}</p>
      ) : (
        <>
          <p className={classes.centre}>
            On the other phone, open the camera and scan this. Use the home Wi-Fi.
          </p>
          <div className={classes.qrBox} style={{ opacity: expired ? 0.2 : 1 }}>
            {/* The SVG is generated locally from our own URL. */}
            {qr && <div dangerouslySetInnerHTML={{ __html: qr }} />}
          </div>
          {data && <p className={classes.bigCode}>{formatPairingCode(data.code)}</p>}
          <p className={classes.centre}>
            {expired
              ? 'This code has expired.'
              : data
                ? `Works once, for ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')} more`
                : '…'}
          </p>
        </>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// App version (session 8.2; moves into settings with 8.1)

/** "Pocket Money Pal v0.2.0": the version running on the family PC. */
function AppVersion() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  if (!health.data) return null;
  const { version } = health.data;
  // A source run without a build has no number: "(dev)".
  const label = /^\d/.test(version) ? `v${version}` : `(${version})`;
  return <p className={classes.appVersion}>Pocket Money Pal {label}</p>;
}

// ---------------------------------------------------------------------------
// Factory reset (ADR 0014)

/**
 * "💣 Factory reset": wipes everything back to a fresh install, behind a sheet where the
 * parent types RESET. This phone then carries on into setup with the new setup token.
 */
function FactoryReset() {
  const ui = useParentUi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const reset = useMutation({
    mutationFn: () => api.factoryReset(typed.trim().toUpperCase()),
    onSuccess: ({ setupToken }) => {
      rememberSetupToken(setupToken);
      sound.sad();
      // Nothing cached is true any more; setup starts from an empty draft.
      queryClient.clear();
      void navigate('/setup', { replace: true });
    },
    onError: (err) => {
      sound.sad();
      ui.notify({ icon: '⚠️', title: 'Not reset', body: problemText(err), tone: 'error' });
    },
  });
  const close = () => {
    setOpen(false);
    setTyped('');
  };
  const confirmed = typed.trim().toUpperCase() === FACTORY_RESET_WORD;

  return (
    <>
      <ArcadeButton
        tone="red"
        size="small"
        onClick={() => {
          sound.tap();
          setOpen(true);
        }}
      >
        💣 Factory reset
      </ArcadeButton>
      <p className={classes.note}>Start over from scratch, as if the app was just installed.</p>

      {open && (
        <Sheet
          opened
          short
          onClose={close}
          head={
            <>
              <span className={classes.sheetTitle}>💣 Factory reset?</span>
              <CloseButton onClick={close} />
            </>
          }
          footer={
            <ArcadeButton
              tone="red"
              disabled={!confirmed || reset.isPending}
              onClick={() => reset.mutate()}
            >
              💣 Erase everything
            </ArcadeButton>
          }
        >
          <p className={classes.note}>
            This erases <b>every</b> player, game master, quest, point, jar, payday and surprise,
            and unpairs every phone, this one too. It can’t be undone.
          </p>
          <p className={classes.note}>
            The kiosk goes back to its title screen, and this phone goes straight into setup.
          </p>
          <p className={classes.note}>Type {FACTORY_RESET_WORD} to confirm:</p>
          <input
            className={classes.codeInput}
            placeholder={FACTORY_RESET_WORD}
            value={typed}
            maxLength={12}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${FACTORY_RESET_WORD} to confirm`}
            onChange={(e) => setTyped(e.target.value)}
          />
        </Sheet>
      )}
    </>
  );
}
