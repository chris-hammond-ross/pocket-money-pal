import { serverEventSchema, WS_PATH, type ServerEvent } from '@pmp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { reportServerVersion } from './updates';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** Queries that only make sense while setup is needed (they answer 409 afterwards). */
export const SETUP_ONLY_QUERIES = ['setup-kiosk', 'setup-draft'];

/** Queries showing the family's chores, points and money: refetched on every data event. */
const FAMILY_QUERIES = [
  'kiosk-today',
  'day',
  'claimed',
  'chores',
  'players',
  'settings',
  'money',
  'savings',
  'payday-latest',
  'surprises',
  'surprise-tasks',
];

/** Queries about paired devices: refetched on `devices.changed`. */
const DEVICE_QUERIES = ['device-me', 'devices', 'pc-invite', 'game-masters'];

/** Events that aren't about the family's data, so the kiosk board needn't refetch. */
const PLUMBING_EVENTS: ServerEvent['type'][] = ['hello', 'presence', 'ping'];

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

interface LiveEventsState {
  status: ConnectionStatus;
  clients: number;
  lastEvent: ServerEvent | null;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
}

const LiveEventsContext = createContext<LiveEventsState | null>(null);

/** Keeps one WebSocket open to the server, reconnecting with backoff. */
export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [clients, setClients] = useState(0);
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);
  const listeners = useRef(new Set<(event: ServerEvent) => void>());

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      setStatus('connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}${WS_PATH}`);

      socket.onopen = () => {
        attempt = 0;
        setStatus('open');
        // We may have missed events while disconnected.
        void queryClient.invalidateQueries();
      };

      socket.onmessage = (message) => {
        const raw: unknown = JSON.parse(String(message.data));
        // Read the version on its own, before the strict parse: a newer server's hello may
        // not match this build's schema, and that's exactly when it matters (ADR 0011).
        if ((raw as { type?: unknown } | null)?.type === 'hello') reportServerVersion(raw);
        const parsed = serverEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const event = parsed.data;
        if (event.type === 'hello' || event.type === 'presence') setClients(event.clients);
        if (event.type === 'settings.updated')
          void queryClient.invalidateQueries({ queryKey: ['settings'] });
        if (event.type === 'devices.changed') {
          // Pairing changed: a revoked phone finds out here, and the PC's card may go.
          for (const key of DEVICE_QUERIES) void queryClient.invalidateQueries({ queryKey: [key] });
        } else if (
          event.type === 'setup.completed' ||
          event.type === 'data.changed' ||
          event.type === 'clock.changed'
        ) {
          // Setup finished, a write from outside the server, or the dev clock moved:
          // anything may have changed.
          void queryClient.invalidateQueries({
            predicate: (q) => !SETUP_ONLY_QUERIES.includes(String(q.queryKey[0])),
          });
        } else if (!PLUMBING_EVENTS.includes(event.type)) {
          // Every change to the family's data refreshes the board, the Day tab and the tray.
          for (const key of FAMILY_QUERIES) void queryClient.invalidateQueries({ queryKey: [key] });
        }
        setLastEvent(event);
        listeners.current.forEach((listener) => listener(event));
      };

      socket.onclose = () => {
        setStatus('closed');
        if (disposed) return;
        const delay = Math.min(1000 * 2 ** attempt++, 15_000);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [queryClient]);

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return (
    <LiveEventsContext.Provider value={{ status, clients, lastEvent, subscribe }}>
      {children}
    </LiveEventsContext.Provider>
  );
}

export function useLiveEvents(): LiveEventsState {
  const ctx = useContext(LiveEventsContext);
  if (!ctx) throw new Error('useLiveEvents must be used inside LiveEventsProvider');
  return ctx;
}
