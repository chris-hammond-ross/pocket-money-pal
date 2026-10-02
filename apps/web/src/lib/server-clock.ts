import { useEffect, useState } from 'react';

/**
 * The server's time, ticking locally once a second (on the server's second boundary).
 * `offsetMs` comes from the last kiosk fetch, so each refetch re-syncs the clock.
 */
export function useServerNow(offsetMs: number): number {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now() + offsetMs;
      setNow(t);
      timer = setTimeout(tick, 1000 - (t % 1000) + 5);
    };
    tick();
    return () => clearTimeout(timer);
  }, [offsetMs]);
  return now;
}
