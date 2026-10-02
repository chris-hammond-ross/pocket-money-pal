import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { AppError } from './components/AppError';
import { KioskPage } from './routes/kiosk';
import { PairPage, ParentPage } from './routes/parent';
import { SetupPage } from './routes/setup/SetupPage';

const routes: RouteObject[] = [
  { path: '/', element: <Navigate to="/kiosk" replace /> },
  { path: '/kiosk', element: <KioskPage /> },
  { path: '/parent', element: <ParentPage /> },
  { path: '/parent/pair', element: <PairPage /> },
  { path: '/setup', element: <SetupPage /> },
  { path: '*', element: <Navigate to="/kiosk" replace /> },
];

// A crash shows AppError (which reloads onto the current build) rather than a blank page.
export const router = createBrowserRouter(
  routes.map((r) => ({ ...r, errorElement: <AppError /> })),
);
