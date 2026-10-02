import { useEffect, useState } from 'react';
import { setMuted } from './sounds';

const MUTED_KEY = 'pmp.parent.muted';

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

/** The phone's mute setting (spec 003): kept on this phone only, like a ringer switch. */
export function useMuted(): [boolean, (muted: boolean) => void] {
  const [muted, set] = useState(readMuted);
  useEffect(() => setMuted(muted), [muted]);
  return [
    muted,
    (next) => {
      set(next);
      try {
        localStorage.setItem(MUTED_KEY, next ? '1' : '0');
      } catch {
        // Private mode: the setting lasts until the page closes.
      }
    },
  ];
}
