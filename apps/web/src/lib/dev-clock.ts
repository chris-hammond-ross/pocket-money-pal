import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './api';

/**
 * Development only: `/kiosk?now=18:40` (or `?now=2026-10-25T07:05`) moves the server's
 * clock, which keeps ticking from there; `?now=off` puts it back. The parameter is then
 * dropped from the address bar so a reload doesn't jump back. The server refuses (404)
 * unless it runs with PMP_DEV_CLOCK=1.
 */
export function useDevClockParam(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const value = params.get('now');
    if (value === null) return;
    params.delete('now');
    const query = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}`);
    api
      .setDevClock(value === 'off' ? null : value)
      .then(() => queryClient.invalidateQueries())
      .catch((err: unknown) => console.warn('Could not move the dev clock:', err));
  }, [queryClient]);
}
