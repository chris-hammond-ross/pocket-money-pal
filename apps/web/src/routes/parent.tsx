import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ArcadeButton } from '../components/arcade';
import type { Banner } from '../components/parent/context';
import { PairScreen } from '../components/parent/PairScreen';
import { ParentShell } from '../components/parent/ParentShell';
import { api } from '../lib/api';
import { forgetParentData } from '../lib/offline';
import { clearOutbox } from '../lib/outbox';

/**
 * `/parent`: the parents' phone (spec 003). It redirects to /setup while setup is needed,
 * shows "Pair this phone" to a phone that isn't paired (or was revoked), and otherwise the
 * Day / Week / Players shell. A revoked phone drops to the pair screen as soon as the
 * `devices.changed` event makes it re-check itself (ADR 0008).
 */
export function ParentPage() {
  const location = useLocation();
  const [welcome, setWelcome] = useState<Banner | null>(() => {
    const state = location.state as { justSetUp?: boolean; justPaired?: string } | null;
    if (state?.justSetUp) {
      return {
        icon: '🎮',
        title: 'The quest board is live!',
        body: 'The family PC is showing today’s quests.',
      };
    }
    if (state?.justPaired) return pairedBanner(state.justPaired);
    return null;
  });
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: api.setupStatus,
    refetchInterval: retryWhileUnreachable,
  });
  const me = useQuery({
    queryKey: ['device-me'],
    queryFn: api.deviceMe,
    refetchInterval: retryWhileUnreachable,
  });

  // Unpaired (or revoked): nothing kept or queued on this phone is any use now.
  const unpaired = me.data === null;
  useEffect(() => {
    if (!unpaired) return;
    forgetParentData();
    void clearOutbox();
  }, [unpaired]);

  if (status.data?.needed) return <Navigate to="/setup" replace />;
  // With the PC off, a phone that can queue changes opens on its last data (spec 007).
  if (me.data === undefined && me.isError) {
    return (
      <Unreachable
        onRetry={() => {
          void status.refetch();
          void me.refetch();
        }}
      />
    );
  }
  if (me.data === undefined) return null;
  if (me.data === null) {
    return <PairScreen onPaired={(paired) => setWelcome(pairedBanner(paired.parent.name))} />;
  }
  return <ParentShell welcome={welcome} />;
}

/** Can't reach the family PC: keep trying every few seconds, so the app comes back by itself. */
const UNREACHABLE_RETRY_MS = 5000;
function retryWhileUnreachable(query: { state: { status: string } }): number | false {
  return query.state.status === 'error' ? UNREACHABLE_RETRY_MS : false;
}

/**
 * The phone couldn't reach the server (the PC is off or restarting, or the phone isn't on
 * the home Wi-Fi or Tailscale). Said plainly, never a blank screen; it carries on trying.
 */
function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div style={{ maxWidth: 420, margin: '20vh auto 0', padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 48 }}>🐷</div>
      <h2>Can’t reach the family PC</h2>
      <p style={{ opacity: 0.8 }}>
        Check the PC is on, and that this phone is on the home Wi-Fi (or Tailscale). This screen
        keeps trying by itself.
      </p>
      <ArcadeButton onClick={onRetry}>Try again</ArcadeButton>
    </div>
  );
}

function pairedBanner(name: string): Banner {
  return { icon: '📱', title: `Paired as ${name}`, body: 'Claimed chores show up in the tray.' };
}

/** `/parent/pair?code=…`: where a pairing QR code leads. */
export function PairPage() {
  const me = useQuery({
    queryKey: ['device-me'],
    queryFn: api.deviceMe,
    refetchInterval: retryWhileUnreachable,
  });
  if (me.isError && !me.isSuccess) {
    return <Unreachable onRetry={() => void me.refetch()} />;
  }
  if (!me.isSuccess) return null;
  if (me.data) {
    return <Navigate to="/parent" replace state={{ justPaired: me.data.parent.name }} />;
  }
  return <PairScreen />;
}
