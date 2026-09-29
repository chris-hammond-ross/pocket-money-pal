import { Container, Group, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { formatMoney } from '@pmp/shared';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { PingPanel } from '../components/PingPanel';
import { api } from '../lib/api';

/** Placeholder for the parents' phone view (approvals, surprise tasks, settings). */
export function ParentPage() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const s = settings.data;

  return (
    <Container size="xs" p="md">
      <Stack>
        <Group justify="space-between">
          <Title order={2}>Parent</Title>
          <ConnectionBadge />
        </Group>
        {s && (
          <Text c="dimmed">
            {s.familyName} · 1 point = {formatMoney(s.centsPerPoint, s.currency)}
          </Text>
        )}
        <PingPanel from="Parent phone" />
      </Stack>
    </Container>
  );
}
