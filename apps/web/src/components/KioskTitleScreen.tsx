import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { phoneBaseUrls, useQrSvg } from '../lib/qr';
import classes from './KioskTitleScreen.module.css';

/**
 * The kiosk while setup is needed (spec 003, "Access"): the title screen, with a QR code
 * for /setup carrying the one-time setup token. The kiosk switches to the board by itself
 * when setup finishes (the `setup.completed` event).
 */
export function KioskTitleScreen() {
  const info = useQuery({ queryKey: ['setup-kiosk'], queryFn: api.setupKiosk, retry: 1 });
  const bases = info.data ? phoneBaseUrls(info.data, location) : [];
  const url = info.data && bases[0] ? `${bases[0]}/setup?token=${info.data.token}` : null;
  const qr = useQrSvg(url);

  return (
    <div className={classes.screen}>
      <div className={classes.hero}>
        <div className={classes.logo}>🐷</div>
        <h1>
          POCKET
          <br />
          MONEY PAL
        </h1>
        <p>Let’s build your family’s quest board.</p>
        <p className={classes.blink}>PRESS START</p>
      </div>

      <div className={classes.card}>
        <div className={`pixel ${classes.cardTitle}`}>GROWN-UPS: SCAN TO SET UP</div>
        <div className={classes.qr}>
          {qr ? (
            // The SVG is generated locally from our own URL.
            <div dangerouslySetInnerHTML={{ __html: qr }} />
          ) : (
            <span className={classes.qrPlaceholder}>
              {info.isError ? 'No setup code: open this screen on the family PC.' : '…'}
            </span>
          )}
        </div>
        <p className={classes.steps}>
          Scan with your phone’s camera. Use the home Wi-Fi.
          <br />
          It takes about 3 minutes.
        </p>
        {bases.length > 0 && (
          <p className={classes.address}>
            {bases[0]}/setup
            {bases.length > 1 && (
              <small>Not working? The PC is also at {bases.slice(1).join(', ')}</small>
            )}
          </p>
        )}
        <Link to="/setup" className={classes.here}>
          or set it up on this PC ▶
        </Link>
      </div>
    </div>
  );
}
