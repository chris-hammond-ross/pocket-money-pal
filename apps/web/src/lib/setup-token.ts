/**
 * The one-time setup token (ADR 0005). It arrives in the kiosk QR code's URL
 * (`/setup?token=…`); we keep it for this tab and take it out of the address bar so it
 * isn't bookmarked or shared by accident.
 */
const KEY = 'pmp.setupToken';
const HEADER = 'x-setup-token';

/** Fallback when sessionStorage isn't available. */
let memory: string | null = null;

function stored(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Call once on the setup page: moves `?token=` from the URL into this tab's storage. */
export function captureSetupToken(): void {
  const url = new URL(location.href);
  const token = url.searchParams.get('token');
  if (!token) return;
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // No storage (some private modes): `memory` still holds it for this page.
  }
  memory = token;
  url.searchParams.delete('token');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

export function setupTokenHeaders(): Record<string, string> {
  const token = memory ?? stored();
  return token ? { [HEADER]: token } : {};
}

export function forgetSetupToken(): void {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}
