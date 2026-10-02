import { DEV_BUILD } from '@pmp/shared';
import { useEffect, useState } from 'react';
import { useRouteError } from 'react-router';
import { CLIENT_BUILD } from '../lib/updates';
import { ArcadeButton } from './arcade';

/**
 * A screen crashed (ADR 0011). Usually an old build meeting a newer server, so a built app
 * first reloads by itself (escalating to a cache reset, never looping). If that gave up,
 * or in development, it says so with a button rather than going blank.
 */
export function AppError() {
  const error = useRouteError();
  const [recovering] = useState(() => CLIENT_BUILD !== DEV_BUILD && !!window.pmpRecover?.());
  useEffect(() => {
    console.error(error);
  }, [error]);
  if (recovering) return null;
  return (
    <div style={{ maxWidth: 420, margin: '20vh auto 0', padding: 24, textAlign: 'center' }}>
      <h2>Something went wrong</h2>
      <p style={{ opacity: 0.8 }}>Reloading usually fixes it.</p>
      <ArcadeButton onClick={() => location.reload()}>Reload</ArcadeButton>
    </div>
  );
}
