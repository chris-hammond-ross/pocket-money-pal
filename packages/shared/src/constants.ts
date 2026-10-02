/** Default port the server listens on (LAN-wide). */
export const DEFAULT_PORT = 4789;

/** Path of the WebSocket endpoint on the server. */
export const WS_PATH = '/ws';

/** How long a phone's "Pair another phone" code works (ADR 0008). It works once. */
export const PAIRING_CODE_MINUTES = 10;

/**
 * Version of the HTTP/WebSocket API between the server and its web client (ADR 0011).
 * Bump it only for a change an older client can't cope with: it makes every open screen
 * reload at once. Anything else is a new build, which screens pick up when it's safe.
 */
export const API_VERSION = 1;
