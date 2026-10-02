import {
  choreStage,
  formatMinutesLeft,
  maxPointsNow,
  nextDeadline,
  questTrack,
  sendBackNote,
  trackPercent,
  type ChoreStage,
  type KioskQuest,
} from '@pmp/shared';
import { clockTime, clockTimeAt } from '../../lib/format';
import { sound } from '../../lib/sounds';
import classes from './kiosk.module.css';

/** The status line under an open quest's title (spec 001, "Quest card"). */
export function statusLine(quest: KioskQuest, stage: ChoreStage, now: number): string {
  const left = formatMinutesLeft((nextDeadline(quest.window, now) ?? now) - now);
  switch (stage) {
    case 'bonus':
      return `⚡ Bonus ends in ${left}`;
    case 'due':
      return `🏁 Due in ${left}`;
    case 'overdue':
      return `⚠️ Overdue! ${left} before points drop`;
    case 'late':
      return `💀 Late: −${quest.loot.latePenalty} points`;
  }
}

function SharedTag({ quest }: { quest: KioskQuest }) {
  return quest.shared ? <span className={classes.tag}>👫 Shared</span> : null;
}

/** The quest's own window, with ⚡ and 🏁 markers and the moving "now" dot. */
function TrackBar({ quest, now, dayStart }: { quest: KioskQuest; now: number; dayStart: number }) {
  const track = questTrack(quest.window, dayStart);
  const pct = (t: number) => trackPercent(track, t);
  const bonus = pct(quest.window.bonusBefore);
  const due = pct(quest.window.dueBy);
  const position = pct(now);
  return (
    <div className={classes.track}>
      <div className={classes.zoneBonus} style={{ left: 0, width: `${bonus}%` }} />
      <div className={classes.zoneDue} style={{ left: `${bonus}%`, width: `${due - bonus}%` }} />
      <div className={classes.zoneLate} style={{ left: `${due}%` }} />
      <div className={classes.gone} style={{ width: `${position}%` }} />
      <Marker at={bonus} passed={now > quest.window.bonusBefore}>
        ⚡ {clockTime(quest.times.bonusBefore)}
      </Marker>
      <Marker at={due} passed={now > quest.window.dueBy}>
        🏁 {clockTime(quest.times.dueBy)}
      </Marker>
      <div className={classes.now} style={{ left: `${position}%` }} />
    </div>
  );
}

function Marker({ at, passed, children }: { at: number; passed: boolean; children: string[] }) {
  return (
    <div className={classes.marker} style={{ left: `${at}%` }} data-passed={passed || undefined}>
      <span>{children}</span>
    </div>
  );
}

/** Tap to claim (spec 001): the card is a button, and plays its click straight away. */
export function OpenQuestCard({
  quest,
  now,
  dayStart,
  onClaim,
}: {
  quest: KioskQuest;
  now: number;
  dayStart: number;
  onClaim: (quest: KioskQuest) => void;
}) {
  const stage = choreStage(quest.window, now);
  const claim = () => {
    sound.tap();
    onClaim(quest);
  };
  return (
    <div
      className={classes.quest}
      data-stage={stage}
      data-quest-id={quest.id}
      role="button"
      tabIndex={0}
      onClick={claim}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        claim();
      }}
    >
      <div className={classes.questIcon}>{quest.icon}</div>
      <div>
        <div className={classes.questTitle}>{quest.title}</div>
        <div className={classes.meta}>
          <span className={classes.phase}>{statusLine(quest, stage, now)}</span>
          <SharedTag quest={quest} />
          {/* On the status line, so a sent-back card is no taller (a column mustn't scroll). */}
          {quest.sentBack && (
            <span className={classes.sentBack}>
              {sendBackNote(quest.sentBack.reason, quest.sentBack.by)}
            </span>
          )}
        </div>
        <TrackBar quest={quest} now={now} dayStart={dayStart} />
      </div>
      <div className={classes.reward}>
        +{maxPointsNow(quest.loot, quest.window, now)}
        <small>up to</small>
      </div>
    </div>
  );
}

export function ClaimedQuestCard({ quest, timezone }: { quest: KioskQuest; timezone: string }) {
  return (
    <div className={`${classes.quest} ${classes.claimed}`} data-quest-id={quest.id}>
      <div className={classes.questIcon}>{quest.icon}</div>
      <div>
        <div className={classes.questTitle}>{quest.title}</div>
        <div className={classes.meta}>
          <span className={classes.phase}>
            <span className={classes.waiting}>✋</span>{' '}
            {quest.claimedAt !== null && `Done at ${clockTimeAt(quest.claimedAt, timezone)}. `}
            Waiting for a parent to check
          </span>
          <SharedTag quest={quest} />
        </div>
      </div>
      <div className={classes.reward}>
        +{quest.pendingPoints ?? 0}
        <small>pending</small>
      </div>
    </div>
  );
}

export function ApprovedQuestRow({ quest }: { quest: KioskQuest }) {
  return (
    <div className={`${classes.quest} ${classes.approved}`} data-quest-id={quest.id}>
      <div className={classes.doneIcon}>✅</div>
      <div className={classes.questTitle}>{quest.title}</div>
      <div className={classes.reward}>+{quest.awardedPoints ?? 0}</div>
    </div>
  );
}
