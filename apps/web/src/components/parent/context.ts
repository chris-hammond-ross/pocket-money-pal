import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { api, ApiError } from '../../lib/api';

export interface Banner {
  icon: string;
  title: string;
  body?: string;
  tone?: 'error';
  onClick?: () => void;
}

/** What the phone's tabs share: the in-app banner, the editor, and the tray. */
export interface ParentUi {
  notify: (banner: Banner) => void;
  openQuest: (choreId: number) => void;
  /** Opens the new-quest picker; the one-off tile shows when today is selected. */
  newQuest: (options: { offerOneOff: boolean; childId?: number }) => void;
  openTray: () => void;
}

export const ParentUiContext = createContext<ParentUi | null>(null);

export function useParentUi(): ParentUi {
  const ui = useContext(ParentUiContext);
  if (!ui) throw new Error('useParentUi must be used inside the parent shell');
  return ui;
}

/** A day's plan (`'today'` or a date), and how far this phone's clock is from the server's. */
export function useDay(date: string) {
  return useQuery({
    queryKey: ['day', date],
    queryFn: async () => {
      const sent = Date.now();
      const plan = await api.day(date);
      return { ...plan, clockOffsetMs: plan.serverNow - (sent + Date.now()) / 2 };
    },
  });
}

export function useTray() {
  return useQuery({ queryKey: ['claimed'], queryFn: api.claimed });
}

/** A failed call, in words for the banner. */
export function problemText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'This phone isn’t paired any more.';
    if (err.status === 409) return 'Someone else got there first. The list has been refreshed.';
    if (err.status === 400) return 'That doesn’t look right. Check it and try again.';
  }
  return 'Can’t reach the family PC. Check you’re on the home Wi-Fi.';
}
