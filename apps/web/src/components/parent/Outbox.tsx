import {
  decodeReplaced,
  outboxLabel,
  outboxOutcome,
  type OutboxResult,
  type SchedulePause,
} from '@pmp/shared';
import { useEffect, useRef } from 'react';
import { clockTimeAt, formatDate } from '../../lib/format';
import { useFamilyPc } from '../../lib/offline';
import {
  cancelQueued,
  dismissResult,
  markAnnounced,
  registerBackgroundSync,
  requestFlush,
  useOutbox,
} from '../../lib/outbox';
import { sound } from '../../lib/sounds';
import { ArcadeButton, PixelLabel, Sheet } from '../arcade';
import { useParentUi, type Banner } from './context';
import classes from './outbox.module.css';
import parentClasses from './parent.module.css';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A queued holiday in words, for the queue sheet: "from Fri 9 Oct to Sun 11 Oct". */
export function pauseName(pause: SchedulePause | null): string {
  if (pause === null) return 'back on, right now';
  const from = `from ${formatDate(pause.from)}`;
  return pause.until === null
    ? `${from}, until you resume`
    : `${from} to ${formatDate(pause.until)}`;
}

/** What happened to a sent change, in words (spec 007, "Changes that can't be applied"). */
export function resultText(r: OutboxResult, timezone: string): string {
  const quest = `‘${r.name}’`;
  switch (outboxOutcome(r)) {
    case 'sent':
      return `${r.kind === 'pause' ? 'Holiday change' : quest} sent.`;
    case 'look': {
      if (r.moved !== null && r.pause) {
        return `The holiday starts today instead of ${formatDate(r.pause.from)}.`;
      }
      const replaced = decodeReplaced(r.replaced);
      const what = r.kind === 'pause' ? 'holiday change' : `change to ${quest}`;
      return replaced
        ? `Your ${what} replaced a change by ${replaced.by} at ${clockTimeAt(replaced.at, timezone)}.`
        : `Your ${what} went through.`;
    }
    case 'failed':
      if (r.status === 401) return `This phone isn’t paired any more, so ${quest} wasn’t sent.`;
      if (r.code === 'date-passed') return `${quest} was a one-off for a day that has passed.`;
      if (r.code === 'pause-over') {
        return `The holiday ${r.name} was over before the family PC came on.`;
      }
      if (r.status === 404) {
        return `${quest} was deleted on the family PC, so your ${r.kind === 'chore.update' ? 'edit' : 'change'} wasn’t applied.`;
      }
      return `Your change to ${r.kind === 'pause' ? 'the holiday' : quest} wasn’t applied: that doesn’t look right.`;
  }
}

/**
 * The offline queue on the phone (spec 007): asks the service worker to send it whenever
 * the app comes to the front, hands it to Background Sync when the app is put away, and
 * says how it went once it's sent.
 */
export function useOutboxSending(
  notify: (banner: Banner) => void,
  timezone: string,
  openSheet: () => void,
): void {
  const { queue, results } = useOutbox();
  const pc = useFamilyPc();
  const announced = useRef(new Set<string>());

  useEffect(() => {
    requestFlush();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') requestFlush();
      else void registerBackgroundSync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    // Say how it went once the queue has gone, or stopped because the PC went off again.
    if (queue.length > 0 && pc === 'on') return;
    const fresh = results.filter((r) => !r.announced && !announced.current.has(r.key));
    if (fresh.length === 0) return;
    fresh.forEach((r) => announced.current.add(r.key));
    const bad = fresh.filter((r) => outboxOutcome(r) !== 'sent');
    if (bad.length > 0) {
      sound.sad();
      notify({
        icon: '⚠️',
        title: `${plural(bad.length, 'change needs', 'changes need')} a look`,
        body: resultText(bad[0]!, timezone),
        tone: 'error',
        onClick: openSheet,
      });
    } else {
      sound.coin();
      notify({
        icon: '✓',
        title: `${plural(fresh.length, 'change', 'changes')} sent to the family PC`,
        body: 'The quest board is up to date.',
      });
    }
    void markAnnounced(
      fresh.map((r) => r.key),
      (r) => outboxOutcome(r) !== 'sent',
    );
  }, [queue.length, results, pc, notify, timezone, openSheet]);
}

/** The slim bar above the tabs: the PC is off, changes are waiting, or need a look. */
export function OfflineBar({ onOpen }: { onOpen: () => void }) {
  const pc = useFamilyPc();
  const { queue, results } = useOutbox();
  const look = results.filter((r) => outboxOutcome(r) !== 'sent').length;
  let text: string | null = null;
  let tone: 'off' | 'sending' | 'look' = 'off';
  if (pc === 'off') {
    text = `🌙 Family PC is off · ${
      queue.length > 0
        ? `${plural(queue.length, 'change', 'changes')} waiting`
        : 'changes will wait here'
    }`;
  } else if (queue.length > 0) {
    tone = 'sending';
    text = `⏳ Sending ${plural(queue.length, 'change', 'changes')}…`;
  } else if (look > 0) {
    tone = 'look';
    text = `⚠️ ${plural(look, 'change needs', 'changes need')} a look`;
  }
  if (text === null) return null;
  return (
    <button
      type="button"
      className={classes.bar}
      data-tone={tone}
      onClick={() => {
        sound.tap();
        onOpen();
      }}
    >
      {text}
    </button>
  );
}

/** WAITING TO SEND and NEEDS A LOOK. */
export function OutboxSheet({ timezone, onClose }: { timezone: string; onClose: () => void }) {
  const ui = useParentUi();
  const pc = useFamilyPc();
  const { queue, results } = useOutbox();
  const look = results.filter((r) => outboxOutcome(r) !== 'sent');
  return (
    <Sheet
      opened
      short
      onClose={onClose}
      head={<span className={parentClasses.sheetTitle}>📮 Changes on this phone</span>}
      footer={
        <ArcadeButton tone="ghost" size="small" onClick={onClose}>
          Close
        </ArcadeButton>
      }
    >
      <PixelLabel>WAITING TO SEND</PixelLabel>
      {queue.length === 0 ? (
        <p className={parentClasses.note}>Nothing waiting.</p>
      ) : (
        <>
          {queue.map((item) => (
            <div key={item.key} className={parentClasses.row}>
              <span className={parentClasses.rowIcon}>⏳</span>
              <div className={parentClasses.grow}>
                <b>{outboxLabel(item)}</b>
              </div>
              <button
                type="button"
                aria-label={`Don’t send ${outboxLabel(item)}`}
                onClick={() => {
                  sound.tap();
                  void cancelQueued(item.key);
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <p className={parentClasses.note}>
            {pc === 'off'
              ? 'They’ll be sent when this phone can reach the family PC: open the app once it’s on.'
              : 'Sending now…'}
          </p>
        </>
      )}
      {look.length > 0 && (
        <>
          <PixelLabel>NEEDS A LOOK</PixelLabel>
          {look.map((r) => (
            <div key={r.key} className={parentClasses.row}>
              <span className={parentClasses.rowIcon}>
                {outboxOutcome(r) === 'failed' ? '⚠️' : 'ℹ️'}
              </span>
              <div
                className={parentClasses.grow}
                onClick={
                  r.choreId !== null && r.choreId > 0 && r.kind !== 'chore.delete'
                    ? () => {
                        onClose();
                        ui.openQuest(r.choreId!);
                      }
                    : undefined
                }
              >
                <small>{resultText(r, timezone)}</small>
              </div>
              <button
                type="button"
                onClick={() => {
                  sound.tap();
                  void dismissResult(r.key);
                }}
              >
                OK
              </button>
            </div>
          ))}
        </>
      )}
    </Sheet>
  );
}

/** A tab that can't be used with the PC off. */
export function NeedsPc({ what }: { what: string }) {
  return (
    <div className={classes.needsPc}>
      <div className={classes.needsPcIcon}>🌙</div>
      <b>{what} needs the family PC to be on</b>
      <p>Quests and holidays can still be planned on the Day and Week tabs.</p>
    </div>
  );
}
