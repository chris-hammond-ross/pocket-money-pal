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
 *
 * 2: `streak` replaced `streakDays` on the kiosk board and the player cards (ADR 0012).
 * 3: a surprise for all children can only be grabbed together (spec 006), so an older
 *    kiosk's "I'll do it!" buttons on one would be refused.
 */
export const API_VERSION = 3;
