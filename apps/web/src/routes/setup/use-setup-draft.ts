import { DEFAULT_CENTS_PER_POINT, type SetupDraft } from '@pmp/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../lib/api';

export const EMPTY_DRAFT: SetupDraft = {
  stage: 'title',
  parentNames: [''],
  children: [],
  chores: [],
  centsPerPoint: DEFAULT_CENTS_PER_POINT,
};

const SAVE_DELAY_MS = 400;

/**
 * Setup state kept in the page and mirrored to the server as a draft (spec 003), so a
 * reload keeps grown-up names, players, quests and the rate. PINs live only in the page
 * (ADR 0005). Saves are debounced, and flushed when the page is hidden.
 */
export function useSetupDraft(initial: SetupDraft) {
  const [draft, setDraftState] = useState<SetupDraft>(initial);
  const [saveError, setSaveError] = useState(false);
  const pending = useRef<SetupDraft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    api.saveSetupDraft(next).then(
      () => setSaveError(false),
      // 409: setup was just finished (here or elsewhere), so the draft no longer matters.
      (err) => setSaveError(!(err instanceof ApiError && err.status === 409)),
    );
  }, []);

  const setDraft = useCallback(
    (update: (draft: SetupDraft) => SetupDraft) => {
      setDraftState((current) => {
        const next = update(current);
        pending.current = next;
        return next;
      });
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [flush]);

  /** Stops saving (after START THE GAME, when the draft is gone on the server). */
  const discard = useCallback(() => {
    clearTimeout(timer.current);
    pending.current = null;
  }, []);

  return { draft, setDraft, saveError, discard };
}
