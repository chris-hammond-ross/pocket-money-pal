import '@mantine/core/styles.css';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { LiveEventsProvider } from './lib/live-events';
import { router } from './router';
import { theme } from './theme';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <QueryClientProvider client={queryClient}>
        <LiveEventsProvider>
          <RouterProvider router={router} />
        </LiveEventsProvider>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
