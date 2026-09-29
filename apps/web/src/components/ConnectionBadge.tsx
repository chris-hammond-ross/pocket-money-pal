import { Badge } from '@mantine/core';
import { useLiveEvents } from '../lib/live-events';

const colours = { open: 'green', connecting: 'yellow', closed: 'red' } as const;
const labels = { open: 'Live', connecting: 'Connecting…', closed: 'Offline' } as const;

export function ConnectionBadge() {
  const { status, clients } = useLiveEvents();
  return (
    <Badge color={colours[status]} variant="dot" size="lg">
      {labels[status]}
      {status === 'open' && ` · ${clients} screen${clients === 1 ? '' : 's'}`}
    </Badge>
  );
}
