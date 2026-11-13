/**
 * Moving this phone to the PC's secure address (ADR 0009, widened by spec 008 and ADR 0025):
 * offered from any address that isn't it, HTTPS included. Changes still queued here go
 * first (spec 007). The move code pairs the phone on the new address and unpairs it here.
 * On the new address, the install screen finishes the job (spec 009, `FinishSetup.tsx`).
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useFamilyPc } from '../../lib/offline';
import { requestFlush, useOutbox } from '../../lib/outbox';
import { pairUrl } from '../../lib/qr';
import { sound } from '../../lib/sounds';
import { ArcadeButton } from '../arcade';
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
