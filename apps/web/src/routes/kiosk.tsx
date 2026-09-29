import { Box, Container, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { PingPanel } from '../components/PingPanel';
import { api } from '../lib/api';

/** Placeholder kiosk. The real column dashboard comes from the Phase 1 prototype round. */
export function KioskPage() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });

  return (
    <Container fluid p="xl" h="100vh">
      <Stack h="100%">
        <Group justify="space-between">
          <Title order={1}>🪙 Pocket Money Pal</Title>
          <ConnectionBadge />
        </Group>
        <Text c="dimmed">{settings.data?.familyName ?? '…'} · Kiosk</Text>
        <SimpleGrid cols={2} style={{ flex: 1 }}>
          {['Child one', 'Child two'].map((name) => (
            <Box
              key={name}
              bg="gray.1"
              p="xl"
              style={{
                borderRadius: 'var(--mantine-radius-lg)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Text size="xl" c="dimmed">
                {name}’s column
              </Text>
            </Box>
          ))}
        </SimpleGrid>
        <PingPanel from="Kiosk" />
      </Stack>
    </Container>
  );
}
