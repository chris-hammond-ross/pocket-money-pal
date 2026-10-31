import { Switch } from '@mantine/core';
import {
  CURRENCIES,
  DEFAULT_QUIET_HOURS,
  FACTORY_RESET_WORD,
  type CurrencyCode,
  type QuietHours,
} from '@pmp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../lib/api';
import { clockTime } from '../../lib/format';
import { useMuted } from '../../lib/parent-prefs';
import { canPush, disablePush, enablePush, pushState, type PushState } from '../../lib/pwa';
import { rememberSetupToken } from '../../lib/setup-token';
import { sound } from '../../lib/sounds';
import { ArcadeButton, CloseButton, PixelLabel, RateSlider, Sheet } from '../arcade';
import { downloadBackup, RestoreBackup } from './BackupRestore';
import { problemText, useParentUi } from './context';
import classes from './parent.module.css';

/**
 * The Setup tab: the app's version, then the family's settings: the loot rate (currency and
 * what a point is worth), notifications (this phone's, and quiet hours), sounds (the
 * kiosk's volume and this phone's sounds), data (backup and restore, ADR 0020) and the factory reset (ADR 0014).
 */
export function SetupTab() {
  return (
    <>
      <AppVersion />

      <PixelLabel>LOOT RATE</PixelLabel>
      <CurrencyRow />
      <LootRate />

      <PixelLabel>NOTIFICATIONS</PixelLabel>
      <PushRow />
      <QuietHoursRow />

      <PixelLabel>SOUNDS</PixelLabel>
      <KioskVolume />
      <PhoneSounds />

      <PixelLabel>DATA</PixelLabel>
      <Backup />

      <PixelLabel>DANGER ZONE</PixelLabel>
      <FactoryReset />
    </>
  );
}

// ---------------------------------------------------------------------------
// App version (ADR 0015)

/** "🐷 Pocket Money Pal v0.2.0": the version running on the family PC, full width. */
function AppVersion() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  if (!health.data) return null;
  const { version } = health.data;
  // A source run without a build has no number: "(dev)".
  const label = /^\d/.test(version) ? `v${version}` : `(${version})`;
  return (
    <div className={classes.versionChip}>
      🐷 Pocket Money Pal <b>{label}</b>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loot rate

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

// ---------------------------------------------------------------------------
// Notifications and sounds: push on this phone, quiet hours and the kiosk for the family

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

/** "🔊 Phone sounds": this phone's own taps and coins (kept on the phone, not the PC). */
function PhoneSounds() {
  const [muted, setMuted] = useMuted();
  return (
    <label className={classes.toggleRow}>
      <span>🔊 Phone sounds</span>
      <Switch
        color="gold"
        checked={!muted}
        onChange={(e) => {
          setMuted(!e.currentTarget.checked);
          if (e.currentTarget.checked) sound.coin();
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Data: backup and restore (ADR 0020)

/** "💾 Download backup" and "📦 Restore from a backup", which replaces everything. */
function Backup() {
  const ui = useParentUi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <>
      <ArcadeButton
        tone="ghost"
        size="small"
        onClick={() => {
          sound.tap();
          downloadBackup();
        }}
      >
        💾 Download backup
      </ArcadeButton>
      <p className={classes.note}>
        Everything in one file. Keep it somewhere safe: it can be restored here, after a factory
        reset, or on a new PC.
      </p>
      <RestoreBackup
        setup={false}
        onPc={false}
        className={classes.restoreButton}
        onRestored={(paired) => {
          ui.notify({
            icon: '📦',
            title: 'Backup restored',
            body: paired
              ? 'Everything is back as it was saved.'
              : 'Pair this phone again to carry on.',
          });
          if (paired) {
            void queryClient.invalidateQueries();
          } else {
            queryClient.clear();
            void navigate('/parent', { replace: true });
          }
        }}
      />
    </>
  );
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
            The kiosk goes back to its title screen, and this phone goes straight into setup. Setup
            can restore a backup, so you can pick up where you left off.
          </p>
          <ArcadeButton
            tone="ghost"
            size="small"
            onClick={() => {
              sound.tap();
              downloadBackup();
            }}
          >
            💾 Download a backup first
          </ArcadeButton>
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
