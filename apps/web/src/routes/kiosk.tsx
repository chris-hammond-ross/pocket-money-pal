import { useQuery } from '@tanstack/react-query';
import { KioskBoard } from '../components/kiosk/KioskBoard';
import { KioskTitleScreen } from '../components/KioskTitleScreen';
import { api } from '../lib/api';
import { useDevClockParam } from '../lib/dev-clock';

/** Re-sync the clock with the server this often, even when nothing changes. */
const RESYNC_MS = 10 * 60_000;

/**
 * The kiosk. While setup is needed it shows the title screen with the setup QR code, and
 * switches over by itself when setup finishes. Then it's the Quest Track board, which
 * refetches on every WebSocket event about the family's data.
 */
export function KioskPage() {
  useDevClockParam();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus });
  const ready = status.data?.needed === false;
  const board = useQuery({
    queryKey: ['kiosk-today'],
    queryFn: api.kioskToday,
    enabled: ready,
    refetchInterval: RESYNC_MS,
  });

  if (!status.data) return null;
  if (status.data.needed) return <KioskTitleScreen />;
  if (!board.data) return null;
  return <KioskBoard board={board.data} />;
}
