import { z } from 'zod';
import { pushSubscriptionSchema } from './schemas';

/**
 * The bridge between a page and the native app around it (ADR 0033, ADR 0034). The apps are
 * thin shells around the server's pages; the shell does only what a page can't (scan a QR
 * code, show native notifications, open links outside the app). Each shell implements this
 * contract, and the web side talks to it through `apps/web/src/lib/native.ts`.
 *
 * Messages are JSON strings. The page sends a request with an `id`; the shell answers once
 * with the same `id`. The page checks what a shell offers with `info` and `nativeCan`, never
 * by version number alone, so an old shell keeps working with a newer server, and the other
 * way round.
 */

/** Bumped only when a message changes in a way an older side would misread. */
export const NATIVE_BRIDGE_VERSION = 1;

/** The global the shell puts in the page (Android: `WebViewCompat.addWebMessageListener`). */
export const NATIVE_BRIDGE_OBJECT = 'pmpNative';

export const nativeAppSchema = z.enum(['kiosk', 'parent']);
export type NativeApp = z.infer<typeof nativeAppSchema>;

export const nativePlatformSchema = z.enum(['android', 'ios']);
export type NativePlatform = z.infer<typeof nativePlatformSchema>;

/** What a shell can do for the page beyond `info`. */
export const nativeFeatureSchema = z.enum(['scanQr', 'openExternal', 'push']);
export type NativeFeature = z.infer<typeof nativeFeatureSchema>;

const idSchema = z.string().min(1).max(64);

/** Page → shell. */
export const nativeRequestSchema = z.discriminatedUnion('type', [
  /** What the shell is: answered by every shell, whatever else it offers. */
  z.object({ id: idSchema, type: z.literal('info') }),
  /** Open the camera and read a QR code. */
  z.object({ id: idSchema, type: z.literal('scanQr') }),
  /** Open a link in the phone's browser, outside the app. */
  z.object({
    id: idSchema,
    type: z.literal('openExternal'),
    url: z.url({ protocol: /^https?$/ }).max(2000),
  }),
  /** Whether notifications are allowed; with `ask`, asks the phone's question if it hasn't been. */
  z.object({ id: idSchema, type: z.literal('push.permission'), ask: z.boolean().optional() }),
  /**
   * A Web Push subscription for the server's VAPID key (base64url), as a browser's
   * `PushSubscription.toJSON()`. Its endpoint is the push gateway (ADR 0033).
   */
  z.object({
    id: idSchema,
    type: z.literal('push.subscribe'),
    applicationServerKey: z.string().min(1).max(200),
  }),
  /** Drop this phone's push subscription. */
  z.object({ id: idSchema, type: z.literal('push.unsubscribe') }),
]);
export type NativeRequest = z.infer<typeof nativeRequestSchema>;
export type NativeRequestType = NativeRequest['type'];
/** A request's own fields, without the envelope. */
export type NativeRequestPayload<T extends NativeRequestType> = Omit<
  Extract<NativeRequest, { type: T }>,
  'id' | 'type'
>;

/** The answer to `info`. */
export const nativeInfoSchema = z.object({
  app: nativeAppSchema,
  /** The app's own version (not the server's). */
  version: z.string().min(1).max(64),
  platform: nativePlatformSchema,
  bridgeVersion: z.number().int().min(1),
  /** Read leniently: a newer shell may list features this page doesn't know, which it ignores. */
  features: z
    .array(z.string().max(64))
    .max(64)
    .transform((names) => names.filter(isNativeFeature)),
});
export type NativeInfo = z.infer<typeof nativeInfoSchema>;

function isNativeFeature(name: string): name is NativeFeature {
  return nativeFeatureSchema.safeParse(name).success;
}

export const nativePushPermissionSchema = z.enum(['granted', 'denied', 'prompt']);
export type NativePushPermission = z.infer<typeof nativePushPermissionSchema>;

/** The `result` of a successful answer, per request type. */
export const nativeResultSchemas = {
  info: nativeInfoSchema,
  scanQr: z.object({ text: z.string().max(4096) }),
  openExternal: z.object({}),
  'push.permission': z.object({ state: nativePushPermissionSchema }),
  'push.subscribe': pushSubscriptionSchema,
  'push.unsubscribe': z.object({}),
} satisfies Record<NativeRequestType, z.ZodType>;
export type NativeResult<T extends NativeRequestType> = z.infer<(typeof nativeResultSchemas)[T]>;

/**
 * Why a request failed. `unsupported`: this shell (or no shell) can't do it. `cancelled`: the
 * person backed out (closed the scanner). `denied`: the phone refused (notifications off).
 */
export const nativeErrorCodeSchema = z.enum(['unsupported', 'cancelled', 'denied', 'failed']);
export type NativeErrorCode = z.infer<typeof nativeErrorCodeSchema>;

/** Shell → page: the one answer to a request. */
export const nativeResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: idSchema, ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: idSchema,
    ok: z.literal(false),
    error: z.object({
      // A code from a newer shell reads as a plain failure.
      code: nativeErrorCodeSchema.catch('failed'),
      message: z.string().max(500).optional(),
    }),
  }),
]);
export type NativeResponse = z.infer<typeof nativeResponseSchema>;

/** The shell can do `feature`. `null` info means the page isn't in an app. */
export function nativeCan(info: NativeInfo | null, feature: NativeFeature): boolean {
  return info !== null && info.features.includes(feature);
}
