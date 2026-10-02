import { SEND_BACK_REASONS, type SendBackReason } from '@pmp/shared';
import { arcade } from '../../theme';
import { ArcadeButton, Sheet } from '../arcade';
import classes from './parent.module.css';

/**
 * "Send back to Billy?" (spec 002's four reasons). "Keep it waiting" returns the card to
 * the tray untouched.
 */
export function SendBackSheet({
  target,
  onPick,
  onKeep,
}: {
  target: { childName: string; avatar: string; title: string } | null;
  onPick: (reason: SendBackReason) => void;
  onKeep: () => void;
}) {
  return (
    <Sheet
      opened={target !== null}
      onClose={onKeep}
      short
      colour={arcade.overdue}
      head={
        <span className={classes.sheetTitle}>
          ↩ Send back to {target?.avatar} {target?.childName}?
        </span>
      }
      footer={
        <ArcadeButton tone="ghost" onClick={onKeep}>
          Keep it waiting
        </ArcadeButton>
      }
    >
      <p className={classes.lead}>“{target?.title}” goes back on their board with your note.</p>
      <div className={classes.reasons}>
        {(Object.keys(SEND_BACK_REASONS) as SendBackReason[]).map((reason) => (
          <button key={reason} type="button" onClick={() => onPick(reason)}>
            {SEND_BACK_REASONS[reason]}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
