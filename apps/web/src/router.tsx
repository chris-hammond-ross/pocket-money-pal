import { createBrowserRouter, Navigate } from 'react-router';
import { KioskPage } from './routes/kiosk';
import { ParentPage } from './routes/parent';

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/kiosk" replace /> },
  { path: '/kiosk', element: <KioskPage /> },
  { path: '/parent', element: <ParentPage /> },
  { path: '*', element: <Navigate to="/kiosk" replace /> },
]);
