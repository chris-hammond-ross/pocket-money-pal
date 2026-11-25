/**
 * The native app around the page, when there is one (ADR 0033, ADR 0034). The kiosk app and
 * the parents' app are thin shells around the server's pages; this talks to them through the
 * bridge contract in `@pmp/shared`. In a browser there's no shell: `nativeInfo()` gives `null`
 * and every request fails with `unsupported`, so callers fall back to the web way.
 */
import {
  NATIVE_BRIDGE_OBJECT,
  nativeCan,
  nativeRequestSchema,
  nativeResponseSchema,
  nativeResultSchemas,
  type NativeErrorCode,
  type NativeInfo,
  type NativeRequestPayload,
  type NativeRequestType,
  type NativeResult,
} from '@pmp/shared';

/** The object the shell puts in the page (Android's `addWebMessageListener` gives this shape). */
interface BridgeObject {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export class NativeError extends Error {
  constructor(
    readonly code: NativeErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'NativeError';
  }
}

function bridge(): BridgeObject | null {
  const candidate = (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_OBJECT] as
    Partial<BridgeObject> | undefined;
  return candidate &&
    typeof candidate.postMessage === 'function' &&
    typeof candidate.addEventListener === 'function'
    ? (candidate as BridgeObject)
    : null;
}

/** The page is inside one of the apps. */
export function isNativeShell(): boolean {
  return bridge() !== null;
}

// Requests that wait on the person (a scanner, the phone's question) get longer.
const QUICK_MS = 10_000;
const PERSON_MS = 5 * 60_000;
const WAITS_ON_PERSON = new Set<NativeRequestType>(['scanQr', 'push.permission', 'push.subscribe']);

interface Pending {
  type: NativeRequestType;
  resolve: (result: unknown) => void;
  reject: (error: NativeError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const pending = new Map<string, Pending>();
let listeningTo: BridgeObject | null = null;
let sequence = 0;

function listen(to: BridgeObject): void {
  if (listeningTo === to) return;
  listeningTo = to;
  to.addEventListener('message', (event) => onReply(event.data));
}

/** One answer from the shell. Anything unreadable, or for no request of ours, is ignored. */
function onReply(data: unknown): void {
  if (typeof data !== 'string') return;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }
  const reply = nativeResponseSchema.safeParse(json);
  if (!reply.success) return;
  const request = pending.get(reply.data.id);
  if (!request) return;
  pending.delete(reply.data.id);
  clearTimeout(request.timer);
  if (!reply.data.ok) {
    request.reject(new NativeError(reply.data.error.code, reply.data.error.message));
    return;
  }
  const result = nativeResultSchemas[request.type].safeParse(reply.data.result);
  if (result.success) request.resolve(result.data);
  else request.reject(new NativeError('failed', `The app answered ${request.type} oddly.`));
}

interface RequestOptions {
  /** How long to wait for the answer; 0 waits for ever. */
  timeoutMs?: number;
}

type RequestArgs<T extends NativeRequestType> =
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {} extends NativeRequestPayload<T>
    ? [payload?: NativeRequestPayload<T>, options?: RequestOptions]
    : [payload: NativeRequestPayload<T>, options?: RequestOptions];

/**
 * Asks the shell to do something. Rejects with a `NativeError`: `unsupported` in a browser,
 * or whatever the shell answers.
 */
export function nativeRequest<T extends NativeRequestType>(
  type: T,
  ...[payload, options]: RequestArgs<T>
): Promise<NativeResult<T>> {
  const to = bridge();
  if (!to) return Promise.reject(new NativeError('unsupported', 'Not in the app.'));
  const id = `${Date.now().toString(36)}-${++sequence}`;
  const request = nativeRequestSchema.safeParse({ ...payload, id, type });
  if (!request.success) {
    return Promise.reject(new NativeError('failed', `Not a valid ${type} request.`));
  }
  listen(to);
  const timeoutMs = options?.timeoutMs ?? (WAITS_ON_PERSON.has(type) ? PERSON_MS : QUICK_MS);
  return new Promise<NativeResult<T>>((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(id);
            reject(new NativeError('failed', `The app didn't answer ${type}.`));
          }, timeoutMs)
        : undefined;
    pending.set(id, { type, resolve: resolve as (result: unknown) => void, reject, timer });
    try {
      to.postMessage(JSON.stringify(request.data));
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      reject(new NativeError('failed', `Couldn't reach the app.`));
    }
  });
}

let info: Promise<NativeInfo | null> | null = null;

/** What the app around the page is and can do; `null` in a browser. Asked once. */
export function nativeInfo(): Promise<NativeInfo | null> {
  if (!isNativeShell()) return Promise.resolve(null);
  info ??= nativeRequest('info').catch((error: unknown) => {
    console.warn('The app did not say what it is', error);
    info = null; // ask again next time
    return null;
  });
  return info;
}

/**
 * Tells the parents' app where this phone stands (ADR 0035): paired, with the addresses to
 * remember, or not paired any more. Quietly does nothing in a browser, or in an app that
 * doesn't take `session`.
 */
export async function tellShell(session: NativeRequestPayload<'session'>): Promise<void> {
  const shell = await nativeInfo();
  if (!nativeCan(shell, 'session')) return;
  await nativeRequest('session', session).catch((error: unknown) => {
    console.warn('The app did not take the session', error);
  });
}
