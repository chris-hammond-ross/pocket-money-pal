import { createBrowserRouter, Navigate } from 'react-router';
import { KioskPage } from './routes/kiosk';
import { PairPage, ParentPage } from './routes/parent';
import { SetupPage } from './routes/setup/SetupPage';

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/kiosk" replace /> },
  { path: '/kiosk', element: <KioskPage /> },
  { path: '/parent', element: <ParentPage /> },
  { path: '/parent/pair', element: <PairPage /> },
  { path: '/setup', element: <SetupPage /> },
  { path: '*', element: <Navigate to="/kiosk" replace /> },
]);
