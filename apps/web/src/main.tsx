import '@mantine/core/styles.css';
// Self-hosted fonts: the kiosk must work with no internet.
import '@fontsource/fredoka/400.css';
import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import '@fontsource/press-start-2p/400.css';
import './styles/arcade.css';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { UpdateBanner } from './components/UpdateBanner';
import { LiveEventsProvider } from './lib/live-events';
import { captureInstallPrompt } from './lib/pwa';
import { watchForUpdates } from './lib/updates';
import { router } from './router';
import { cssVariablesResolver, theme } from './theme';

const queryClient = new QueryClient();
// Chrome offers its install prompt early; keep it for the Players tab's "📲 Install".
captureInstallPrompt();
// Every screen follows the server's build: reloads quietly, or offers it (ADR 0011).
watchForUpdates();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
      forceColorScheme="dark"
    >
      <QueryClientProvider client={queryClient}>
        <LiveEventsProvider>
          <RouterProvider router={router} />
          <UpdateBanner />
        </LiveEventsProvider>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
