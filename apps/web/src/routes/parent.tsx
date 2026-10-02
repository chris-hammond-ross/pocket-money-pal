import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Banner } from '../components/parent/context';
import { PairScreen } from '../components/parent/PairScreen';
import { ParentShell } from '../components/parent/ParentShell';
import { api } from '../lib/api';

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
  const status = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus });
  const me = useQuery({ queryKey: ['device-me'], queryFn: api.deviceMe });

  if (status.data?.needed) return <Navigate to="/setup" replace />;
  if (!me.isSuccess) return null;
  if (me.data === null) {
    return <PairScreen onPaired={(paired) => setWelcome(pairedBanner(paired.parent.name))} />;
  }
  return <ParentShell welcome={welcome} />;
}

function pairedBanner(name: string): Banner {
  return { icon: '📱', title: `Paired as ${name}`, body: 'Claimed chores show up in the tray.' };
}

/** `/parent/pair?code=…`: where a pairing QR code leads. */
export function PairPage() {
  const me = useQuery({ queryKey: ['device-me'], queryFn: api.deviceMe });
  if (!me.isSuccess) return null;
  if (me.data) {
    return <Navigate to="/parent" replace state={{ justPaired: me.data.parent.name }} />;
  }
  return <PairScreen />;
}
