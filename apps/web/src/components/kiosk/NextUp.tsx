import {
  choreStage,
  formatCountdown,
  isBonusEnding,
  nextDeadline,
  type ChoreStage,
  type KioskQuest,
} from '@pmp/shared';
import classes from './kiosk.module.css';

const LABELS: Record<ChoreStage, string> = {
  bonus: '⚡ NEXT UP · BONUS ENDS SOON',
  due: '🏁 NEXT UP · DUE SOON',
  overdue: '⚠️ OVERDUE!',
  late: '🥀 LATE',
};

/**
 * The "Next up" countdown (spec 001): the column's most pressing open quest, or a trophy
 * when there's nothing left to do. On a sick day (ADR 0012) it says so.
 */
export function NextUp({
  quest,
  hadQuests,
  sick,
  now,
}: {
  quest: KioskQuest | undefined;
  hadQuests: boolean;
  sick: boolean;
  now: number;
}) {
  if (!quest && sick) {
    return (
      <div className={classes.next} data-stage="done">
        <div className={classes.nextIcon}>🤒</div>
        <div>
          <div className={classes.nextLabel}>SICK DAY</div>
          <div className={classes.nextTitle}>Rest up and get well soon!</div>
        </div>
      </div>
    );
  }
  if (!quest) {
    return (
      <div className={classes.next} data-stage="done">
        <div className={classes.nextIcon}>{hadQuests ? '🏆' : '🌴'}</div>
        <div>
          <div className={classes.nextLabel}>
            {hadQuests ? 'ALL QUESTS DONE' : 'NO QUESTS TODAY'}
          </div>
          <div className={classes.nextTitle}>
            {hadQuests ? 'Nothing left today. Legend!' : 'Enjoy your day off!'}
          </div>
        </div>
      </div>
    );
  }

  const stage = choreStage(quest.window, now);
  const deadline = nextDeadline(quest.window, now);
  const caption = {
    bonus: `left for +${quest.loot.earlyBonus} bonus`,
    due: 'until due',
    overdue: 'before points drop',
    late: 'points',
  }[stage];

  return (
    <div
      className={`${classes.next} ${isBonusEnding(quest.window, now) ? classes.urgent : ''}`}
      data-stage={stage}
    >
      <div className={classes.nextIcon}>{quest.icon}</div>
      <div style={{ minWidth: 0 }}>
        <div className={classes.nextLabel}>{LABELS[stage]}</div>
        <div className={classes.nextTitle}>{quest.title}</div>
      </div>
      <div className={classes.countdown}>
        {deadline === null ? `−${quest.loot.latePenalty}` : formatCountdown(deadline - now)}
        <small>{caption}</small>
      </div>
    </div>
  );
}
