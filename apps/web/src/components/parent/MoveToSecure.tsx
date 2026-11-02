/**
 * Moving this phone to the PC's secure address (ADR 0009, widened by spec 008 and ADR 0025):
 * offered from any address that isn't it, HTTPS included. Changes still queued here go
 * first (spec 007). The move code pairs the phone on the new address and unpairs it here.
 * On the new address, the Day tab's after-move sheet finishes the job.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useFamilyPc } from '../../lib/offline';
import { requestFlush, useOutbox } from '../../lib/outbox';
import {
  canPush,
  enablePush,
  isInstalled,
  pushState,
  useInstallPrompt,
  type PushState,
} from '../../lib/pwa';
import { pairUrl } from '../../lib/qr';
import { sound } from '../../lib/sounds';
import { ArcadeButton, CloseButton, Sheet } from '../arcade';
import { problemText, useParentUi } from './context';
import classes from './parent.module.css';

/** The move button's words when the secure address is the relay (Setup, and Players → THIS PHONE). */
export const MOVE_LABEL = '📲 Use remote access on this phone';

/** Where this phone could move to, and whether that's the relay (hands-off) address. */
export function useMoveTarget(): { secureUrl: string | null; needed: boolean; isRelay: boolean } {
  const access = useQuery({ queryKey: ['access'], queryFn: api.access });
  const relay = useQuery({ queryKey: ['relay'], queryFn: api.relay, retry: false });
  const secureUrl = access.data?.secureUrl ?? null;
  const needed = secureUrl !== null && !isHere(secureUrl);
  return { secureUrl, needed, isRelay: secureUrl !== null && relay.data?.url === secureUrl };
}

function isHere(url: string): boolean {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * The move button. With changes waiting it sends them first, and it won't move while any
 * are left (nor while the PC can't be reached: the move code comes from the PC).
 */
export function MoveButton({ label, className }: { label: string; className?: string }) {
  const ui = useParentUi();
  const { secureUrl } = useMoveTarget();
  const { queue } = useOutbox();
  const pc = useFamilyPc();
  const move = useMutation({
    mutationFn: () => api.invite(true),
    onSuccess: (invite) => {
      if (secureUrl) location.href = pairUrl(secureUrl, invite.code, true);
    },
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Couldn’t move', body: problemText(err), tone: 'error' }),
  });
  if (!secureUrl) return null;

  const waiting = queue.length;
  if (waiting > 0) {
    return (
      <>
        <ArcadeButton
          tone="ghost"
          size="small"
          className={className}
          disabled={pc === 'off'}
          onClick={() => {
            sound.tap();
            requestFlush();
          }}
        >
          📤 Send your {waiting === 1 ? 'waiting change' : `${waiting} waiting changes`} first
        </ArcadeButton>
        <p className={classes.note}>
          {pc === 'off'
            ? 'The family PC needs to be on to send them, then this phone can move.'
            : 'They were planned on this address, so they go before the phone moves.'}
        </p>
      </>
    );
  }
  return (
    <ArcadeButton
      tone="ghost"
      size="small"
      className={className}
      disabled={move.isPending || pc === 'off'}
      onClick={() => {
        sound.tap();
        move.mutate();
      }}
    >
      {label}
    </ArcadeButton>
  );
}

// ---------------------------------------------------------------------------
// After the move, on the new address

const AFTER_MOVE_KEY = 'pmp.parent.afterMove';

/** Called when a move code pairs this phone here: the Day tab shows the after-move sheet. */
export function markMoved(): void {
  try {
    localStorage.setItem(AFTER_MOVE_KEY, '1');
  } catch {
    // No storage: no sheet.
  }
}

/** This phone moved here and hasn't finished (or closed) the after-move sheet. */
export function movedHere(): boolean {
  try {
    return localStorage.getItem(AFTER_MOVE_KEY) === '1';
  } catch {
    return false;
  }
}

function forgetMoved(): void {
  try {
    localStorage.removeItem(AFTER_MOVE_KEY);
  } catch {
    // As above.
  }
}

/**
 * The one-time sheet after moving: install the app and turn on notifications. It goes once
 * both are done, or when closed.
 */
export function AfterMoveSheet() {
  const ui = useParentUi();
  const [shown, setShown] = useState(movedHere);
  const install = useInstallPrompt();
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (shown) void pushState().then(setPush);
  }, [shown]);
  const installed = isInstalled();
  const done = installed && push === 'on';
  useEffect(() => {
    if (done) forgetMoved();
  }, [done]);
  if (!shown || done) return null;

  const close = () => {
    forgetMoved();
    setShown(false);
  };

  const turnOnPush = async () => {
    setBusy(true);
    try {
      const next = await enablePush();
      setPush(next);
      if (next === 'on') sound.coin();
      if (next === 'denied') {
        ui.notify({
          icon: '🔕',
          title: 'Notifications are blocked',
          body: 'Allow them for this site in Chrome’s settings, then try again.',
          tone: 'error',
        });
      }
    } catch (err) {
      ui.notify({ icon: '⚠️', title: 'Not turned on', body: problemText(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      opened
      short
      onClose={close}
      head={
        <>
          <span className={classes.sheetTitle}>🎉 This phone has moved</span>
          <CloseButton onClick={close} />
        </>
      }
      footer={
        <ArcadeButton tone="ghost" size="small" onClick={close}>
          Done
        </ArcadeButton>
      }
    >
      <p className={classes.note}>Two quick things to finish:</p>
      <ol className={classes.moveSteps}>
        <li data-done={installed || undefined}>
          <span>Install the app</span>
          {installed ? (
            <span>✓</span>
          ) : install ? (
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
          ) : (
            <small>Chrome’s ⋮ menu → Install app</small>
          )}
        </li>
        <li data-done={push === 'on' || undefined}>
          <span>Turn on notifications</span>
          {push === 'on' ? (
            <span>✓</span>
          ) : canPush() ? (
            <button
              type="button"
              className={classes.pill}
              disabled={busy}
              onClick={() => void turnOnPush()}
            >
              🔔 Turn on
            </button>
          ) : null}
        </li>
      </ol>
    </Sheet>
  );
}
