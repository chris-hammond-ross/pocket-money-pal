import { Button, Card, Group, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useLiveEvents } from '../lib/live-events';

/** Phase 0 plumbing check: pinging from one screen shows up live on every other screen. */
export function PingPanel({ from }: { from: string }) {
  const { subscribe } = useLiveEvents();
  const [lastPing, setLastPing] = useState<{ from: string; at: string } | null>(null);
  const ping = useMutation({ mutationFn: () => api.ping({ from }) });

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === 'ping') setLastPing({ from: event.from, at: event.at });
      }),
    [subscribe],
  );

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between">
        <div>
          <Text fw={700}>Live connection test</Text>
          <Text size="sm" c="dimmed">
            {lastPing
              ? `Last ping from ${lastPing.from} at ${new Date(lastPing.at).toLocaleTimeString()}`
              : 'No pings yet. Press the button on another device.'}
          </Text>
        </div>
        <Button onClick={() => ping.mutate()} loading={ping.isPending}>
          Ping all screens
        </Button>
      </Group>
    </Card>
  );
}
