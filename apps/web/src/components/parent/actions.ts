import type { SendBackReason } from '@pmp/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { sound } from '../../lib/sounds';
import { problemText, useParentUi } from './context';

/**
 * The parent's chore actions (spec 002's API, from the phone): approve, send back, mark
 * done and undo. Every screen refreshes from the server's events; a failure shows in the
 * banner and refetches, so a card that flew off comes back.
 */
export function useChoreActions() {
  const ui = useParentUi();
  const queryClient = useQueryClient();
  const failed = (err: unknown) => {
    sound.sad();
    ui.notify({ icon: '⚠️', title: 'That didn’t work', body: problemText(err), tone: 'error' });
    void queryClient.invalidateQueries({ queryKey: ['claimed'] });
    void queryClient.invalidateQueries({ queryKey: ['day'] });
  };

  const approve = useMutation({
    mutationFn: (ids: number[]) => api.approve(ids.map((id) => ({ id }))),
    onError: failed,
  });
  const sendBack = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: SendBackReason }) =>
      api.sendBack(id, reason),
    onSuccess: () => sound.sad(),
    onError: failed,
  });
  const markDone = useMutation({
    mutationFn: (id: number) => api.markDone(id),
    onSuccess: () => sound.coin(),
    onError: failed,
  });
  const undo = useMutation({
    mutationFn: (id: number) => api.undoApproval(id),
    onSuccess: () => sound.sad(),
    onError: failed,
  });
  return { approve, sendBack, markDone, undo };
}
