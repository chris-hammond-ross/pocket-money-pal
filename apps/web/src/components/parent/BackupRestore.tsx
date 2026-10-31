/**
 * Backup and restore (ADR 0020): "💾 Download backup" on a paired phone, and "📦 Restore
 * backup", used under DATA on the phone's Setup tab and on the setup screen.
 */
import { RESTORE_WORD, type BackupInspectResult } from '@pmp/shared';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { celebrate } from '../../lib/confetti';
import { sound } from '../../lib/sounds';
import { ArcadeButton, CloseButton, Sheet } from '../arcade';
import { problemText } from './context';
import classes from './parent.module.css';

/** Downloads the backup file: the server sends it as an attachment, so the page stays. */
export function downloadBackup(): void {
  const link = document.createElement('a');
  link.href = api.backupUrl;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

/** What went wrong with a backup, in words a parent can act on. */
export function backupProblem(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'backup-invalid':
        return 'That file isn’t a Pocket Money Pal backup, or it’s damaged.';
      case 'backup-newer':
        return 'That backup was made by a newer version. Update the app on the family PC first.';
      case 'backup-old':
        return 'That backup is from an older version this copy can’t update.';
      case 'backup-gone':
        return 'That took too long. Pick the file again.';
      case 'setup-token':
        return 'This setup link has expired. Scan the code on the family PC again.';
      case 'no-parent':
        return 'Pick which grown-up you are.';
    }
    if (err.status === 413) return 'That file is too big to be a backup.';
  }
  return problemText(err);
}

function exportedOn(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * "📦 Restore backup": pick the file, see what's in it, then replace everything. On a
 * paired phone (`setup` false) the parent types RESTORE. A phone the backup doesn't know
 * picks which grown-up it is, and is paired as them.
 */
export function RestoreBackup({
  setup,
  onPc,
  onStart,
  onFailed,
  onRestored,
  className,
}: {
  /** During first-run setup: there's nothing to lose, so no word to type. */
  setup: boolean;
  /** On the family PC: it's never paired, so there's no grown-up to pick. */
  onPc: boolean;
  onStart?: () => void;
  onFailed?: () => void;
  onRestored: (paired: boolean) => void;
  /** For the "📦 Restore from a backup" button: spacing where it sits. */
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState<BackupInspectResult | null>(null);
  const [typed, setTyped] = useState('');
  const [parentId, setParentId] = useState<number | null>(null);

  const close = () => {
    setChecked(null);
    setTyped('');
    setParentId(null);
  };

  const inspect = useMutation({
    mutationFn: api.inspectBackup,
    onSuccess: (result) => {
      sound.pop();
      const { parents } = result.summary;
      setParentId(parents.length === 1 ? parents[0]!.id : null);
      setChecked(result);
    },
    onError: () => sound.sad(),
  });

  const summary = checked?.summary;
  const pickParent = summary !== undefined && !onPc && !summary.knowsThisPhone;
  const restore = useMutation({
    mutationFn: () =>
      api.restoreBackup({
        uploadId: checked!.uploadId,
        confirm: setup ? undefined : typed.trim().toUpperCase(),
        parentId: pickParent && parentId !== null ? parentId : undefined,
      }),
    onMutate: () => onStart?.(),
    onSuccess: ({ paired }) => {
      sound.fanfare();
      celebrate({ count: 160, y: 0.55 });
      close();
      onRestored(paired);
    },
    onError: () => {
      sound.sad();
      onFailed?.();
    },
  });

  const ready =
    (setup || typed.trim().toUpperCase() === RESTORE_WORD) && (!pickParent || parentId !== null);

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".pmpbackup,application/octet-stream"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) inspect.mutate(file);
        }}
      />
      <ArcadeButton
        tone="ghost"
        size="small"
        className={className}
        disabled={inspect.isPending}
        onClick={() => {
          sound.tap();
          inspect.reset();
          input.current?.click();
        }}
      >
        {inspect.isPending ? '📦 Checking the backup…' : '📦 Restore from a backup'}
      </ArcadeButton>
      {inspect.error && <p className={classes.error}>{backupProblem(inspect.error)}</p>}

      {summary && (
        <Sheet
          opened
          short
          onClose={close}
          head={
            <>
              <span className={classes.sheetTitle}>📦 Restore this backup?</span>
              <CloseButton onClick={close} />
            </>
          }
          footer={
            <>
              {restore.error && <p className={classes.error}>{backupProblem(restore.error)}</p>}
              <ArcadeButton
                tone={setup ? 'gold' : 'red'}
                disabled={!ready || restore.isPending}
                onClick={() => restore.mutate()}
              >
                {restore.isPending ? 'Restoring…' : '📦 Restore everything'}
              </ArcadeButton>
            </>
          }
        >
          <div className={classes.row}>
            <span className={classes.rowIcon}>🏠</span>
            <div className={classes.grow}>
              <b>{summary.familyName}</b>
              <small>Saved {exportedOn(summary.exportedAt)}</small>
            </div>
          </div>
          <p className={classes.note}>
            {summary.players.length === 0
              ? 'No players.'
              : summary.players.map((p) => `${p.avatar ?? ''} ${p.name}`.trim()).join(' · ')}
            <br />
            Grown-ups: {summary.parents.map((p) => p.name).join(', ')}
          </p>
          <p className={classes.note}>
            {setup
              ? 'Players, quests, points, jars, paydays and paired phones all come back, just as they were when it was saved.'
              : 'This replaces everything with the backup: anything since it was saved is lost. Phones paired back then are paired again.'}
          </p>

          {pickParent && (
            <>
              <p className={classes.note}>Which grown-up are you? This phone pairs as them.</p>
              <div className={classes.parentChoices}>
                {summary.parents.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-on={parentId === p.id || undefined}
                    onClick={() => {
                      sound.tap();
                      setParentId(p.id);
                    }}
                  >
                    🧙 {p.name}
                  </button>
                ))}
              </div>
            </>
          )}

          {!setup && (
            <>
              <p className={classes.note}>Type {RESTORE_WORD} to confirm:</p>
              <input
                className={classes.codeInput}
                placeholder={RESTORE_WORD}
                value={typed}
                maxLength={12}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                aria-label={`Type ${RESTORE_WORD} to confirm`}
                onChange={(e) => setTyped(e.target.value)}
              />
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
