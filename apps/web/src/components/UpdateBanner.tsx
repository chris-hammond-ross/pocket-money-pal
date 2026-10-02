import { reload, useUpdateStatus } from '../lib/updates';
import classes from './UpdateBanner.module.css';

/**
 * "New version ready" on the phone (ADR 0011). It only shows when the update couldn't be
 * taken quietly: the parent is in the middle of something. Putting the app away takes it
 * too. The kiosk never shows it: it waits for a quiet minute instead.
 */
export function UpdateBanner() {
  const status = useUpdateStatus();
  if (status === 'current' || location.pathname.startsWith('/kiosk')) return null;
  return (
    <button type="button" className={classes.pill} onClick={() => void reload(true)}>
      <span aria-hidden>✨</span>
      {status === 'stale' ? 'New version ready · tap to update' : 'Update needed · tap to reload'}
    </button>
  );
}
