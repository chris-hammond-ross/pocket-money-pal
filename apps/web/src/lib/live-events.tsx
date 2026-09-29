import { serverEventSchema, WS_PATH, type ServerEvent } from '@pmp/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

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
        const parsed = serverEventSchema.safeParse(JSON.parse(String(message.data)));
        if (!parsed.success) return;
        const event = parsed.data;
        if (event.type === 'hello' || event.type === 'presence') setClients(event.clients);
        if (event.type === 'settings.updated')
          void queryClient.invalidateQueries({ queryKey: ['settings'] });
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
