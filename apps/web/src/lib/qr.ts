import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { arcade } from '../theme';

/**
 * Where a phone should go to reach this PC: this page's own HTTPS address if it has one,
 * then `PMP_PUBLIC_URL` if set, otherwise the PC's
 * likeliest home-network address on the port this page was loaded from (4789 when built,
 * Vite's 5173 in development). A page opened by LAN address already has the right host.
 */
export function phoneBaseUrls(
  info: { hosts: string[]; publicUrl: string | null },
  here: { protocol: string; hostname: string; host: string; port: string },
): string[] {
  // A phone already on the HTTPS address invites to that address (ADR 0009).
  if (here.protocol === 'https:' && !isLocal(here.hostname)) return [`https://${here.host}`];
  if (info.publicUrl) return [info.publicUrl];
  if (!isLocal(here.hostname)) return [`${here.protocol}//${here.host}`];
  const port = here.port ? `:${here.port}` : '';
  return info.hosts.map((host) => `${here.protocol}//${host}${port}`);
}

function isLocal(hostname: string): boolean {
  return hostname === 'localhost' || hostname.startsWith('127.');
}

/** A QR code for `url` as an SVG string (made locally), or null while it's drawn. */
export function useQrSvg(url: string | null): string | null {
  const [qr, setQr] = useState<{ url: string; svg: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    void QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: arcade.bg, light: '#ffffff' },
    }).then((svg) => {
      if (!cancelled) setQr({ url, svg });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return qr && qr.url === url ? qr.svg : null;
}

/** The link a new phone opens to pair with a code. */
export function pairUrl(base: string, code: string): string {
  return `${base}/parent/pair?code=${code}`;
}
