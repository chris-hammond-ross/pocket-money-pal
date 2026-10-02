import { formatPairingCode } from '@pmp/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { pairUrl, phoneBaseUrls, useQrSvg } from '../../lib/qr';
import classes from './kiosk.module.css';

/** Codes last 10 minutes; a fresh one is fetched before that. */
const REFRESH_MS = 9 * 60_000;

/**
 * "📱 Pair a parent phone" (ADR 0008): a small corner card with a pairing QR code, shown
 * on the family PC only while no phone is paired at all (for example, after setup was
 * done on the PC). The server decides: it gives no code otherwise, and the card goes as
 * soon as a phone pairs (`devices.changed`).
 */
export function PairPhoneCard() {
  const status = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus });
  const invite = useQuery({
    queryKey: ['pc-invite'],
    queryFn: api.pcInvite,
    enabled: status.data?.onPc === true,
    refetchInterval: REFRESH_MS,
  });
  const base = invite.data ? phoneBaseUrls(invite.data, location)[0] : undefined;
  const url = invite.data && base ? pairUrl(base, invite.data.code) : null;
  const qr = useQrSvg(url);
  if (!invite.data || !qr) return null;

  return (
    <aside className={classes.pairCard} aria-label="Pair a parent phone">
      {/* The SVG is generated locally from our own URL. */}
      <div className={classes.pairQr} dangerouslySetInnerHTML={{ __html: qr }} />
      <div>
        <b>📱 Pair a parent phone</b>
        <p>Grown-ups: scan with your phone’s camera to check chores from your phone.</p>
        <p className={classes.pairCode}>{formatPairingCode(invite.data.code)}</p>
      </div>
    </aside>
  );
}
