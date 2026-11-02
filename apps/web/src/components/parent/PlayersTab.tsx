import {
  BONUS_STEPS,
  DEFAULT_CURRENCY,
  DEFAULT_CHILD_AGE,
  formatMoney,
  formatPairingCode,
  formatPointsChange,
  nextPlayerLook,
  PAIRING_CODE_MINUTES,
  type ChildInput,
  type DeviceList,
  type PlayerCard,
} from '@pmp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../../lib/api';
import { formatMinutesAgo } from '../../lib/format';
import {
  installHintDismissed,
  isSecure,
  isStandalone,
  moveHintDismissed,
  useInstallPrompt,
} from '../../lib/pwa';
import { pairUrl, phoneBaseUrls, useQrSvg } from '../../lib/qr';
import { sound } from '../../lib/sounds';
import { ArcadeButton, CloseButton, DashedButton, PixelLabel, Sheet } from '../arcade';
import { Flame, flameColours } from '../Flame';
import { PlayerEditor } from '../PlayerEditor';
import { problemText, useParentUi, usePlayers } from './context';
import { MOVE_LABEL, MoveButton, useMoveTarget } from './MoveToSecure';
import classes from './parent.module.css';

/** For hands-on families (their own HTTPS, ADR 0021): the install guide's secure-access section. */
export const SECURE_ACCESS_GUIDE =
  'https://github.com/chris-hammond-ross/pocket-money-pal/blob/main/installation.md#secure-access-with-tailscale';

/**
 * The Players tab (spec 003): player cards (with their streak and a sick-day button, spec
 * 005) and the player editor, game masters, paired phones and bonus points, and (when this
 * phone isn't on the PC's secure address) the move button. Over HTTPS it offers "📲 Install";
 * over plain HTTP, a one-time hint. The family's settings live on the Setup tab.
 */
export function PlayersTab() {
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

      <PixelLabel>BONUS POINTS</PixelLabel>
      <BonusPoints />

      <SwitchToSecure label="THIS PHONE" />

      {inviting && <InviteSheet onClose={() => setInviting(false)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Installing (ADR 0002, ADR 0009) and moving to the secure address (ADR 0025)

/**
 * Not on the PC's secure address: "🔒 Move to the app" (the relay) or "🔒 Switch to secure
 * app" (a hands-on HTTPS address). On it, or any HTTPS address, "📲 Install" when Chrome
 * offers it. Over plain HTTP with nowhere to move, a one-time hint to turn on remote access.
 */
function InstallCard() {
  const install = useInstallPrompt();
  const { needed, isRelay } = useMoveTarget();
  const [dismissed, setDismissed] = useState(() => installHintDismissed()[0]);
  const [moveDismissed, setMoveDismissed] = useState(() => moveHintDismissed()[0]);

  if (needed) {
    if (moveDismissed) return null;
    return (
      <div className={classes.hintCard}>
        <span className={classes.rowIcon}>🔒</span>
        <div className={classes.grow}>
          <b>{isRelay ? 'Move to the app' : 'Switch to the secure app'}</b>
          <small>
            {isRelay
              ? 'Remote access is on. Move this phone to its address to install the app, get notifications and use it away from home.'
              : 'The family PC has a secure address. Move this phone to it to install the app and get notifications.'}
          </small>
          <MoveButton
            label={isRelay ? '🔒 Move to the app' : '🔒 Switch to secure app'}
            className={classes.secureButton}
          />
        </div>
        <CloseButton
          onClick={() => {
            moveHintDismissed()[1]();
            setMoveDismissed(true);
          }}
        />
      </div>
    );
  }

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
          Turn on remote access on the ⚙️ Setup tab to install this as an app and get notifications.
          Using your own HTTPS address instead?{' '}
          <a href={SECURE_ACCESS_GUIDE} target="_blank" rel="noreferrer">
            How
          </a>
        </small>
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

/** "THIS PHONE": the move button again, whenever this phone isn't on the secure address. */
function SwitchToSecure({ label }: { label: string }) {
  const { needed, isRelay } = useMoveTarget();
  if (!needed) return null;
  return (
    <>
      <PixelLabel>{label}</PixelLabel>
      <MoveButton
        label={isRelay ? MOVE_LABEL : '🔒 Switch to secure app'}
        className={classes.secureButton}
      />
    </>
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
// Bonus points

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
            On the other phone, open the camera and scan this.
            {data?.secureUrl ? ' It works from anywhere.' : ' Use the home Wi-Fi.'}
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
                ? `This code expires in ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`
                : '…'}
          </p>
        </>
      )}
    </Sheet>
  );
}
