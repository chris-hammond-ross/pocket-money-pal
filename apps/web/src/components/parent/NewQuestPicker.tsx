import { choreFromLibrary, WEEKDAYS, type SetupChore } from '@pmp/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { newKey } from '../../lib/format';
import { sound } from '../../lib/sounds';
import { CloseButton, Sheet } from '../arcade';
import { useDay } from './context';
import classes from './parent.module.css';

/** "✏️ Make my own": sensible times and loot, ready to adjust. */
function blankQuest(childKeys: string[], oneOffDate: string | null): SetupChore {
  return {
    key: newKey('new'),
    libraryId: null,
    title: '',
    icon: '⭐',
    together: false,
    bonusBefore: '17:00',
    dueBy: '18:00',
    lateAfter: '19:00',
    basePoints: 5,
    earlyBonus: 2,
    unpromptedBonus: 2,
    latePenalty: 1,
    days: oneOffDate ? [] : [...WEEKDAYS],
    oneOffDate,
    childKeys,
  };
}

/**
 * "+ New quest" (spec 003): make your own, a one-off for today, or a library tile the
 * family doesn't have yet (its times, loot and days come pre-filled). Every choice opens
 * the editor, so it can be adjusted before saving.
 */
export function NewQuestPicker({
  opened,
  offerOneOff,
  childId,
  onPick,
  onClose,
}: {
  opened: boolean;
  offerOneOff: boolean;
  childId: number | undefined;
  onPick: (draft: SetupChore) => void;
  onClose: () => void;
}) {
  const library = useQuery({ queryKey: ['chore-library'], queryFn: api.choreLibrary });
  const chores = useQuery({ queryKey: ['chores'], queryFn: api.chores });
  const today = useDay('today');
  const plan = today.data;
  const used = new Set((chores.data ?? []).map((c) => c.libraryId).filter(Boolean));
  const childKeys = childId ? [String(childId)] : (plan?.children ?? []).map((c) => String(c.id));

  const pick = (draft: SetupChore) => {
    sound.pop();
    onPick(draft);
  };

  return (
    <Sheet
      opened={opened}
      onClose={onClose}
      head={
        <>
          <b className="pixel" style={{ flex: 1, fontSize: 11, color: 'var(--pmp-gold)' }}>
            NEW QUEST
          </b>
          <CloseButton onClick={onClose} />
        </>
      }
    >
      <div className={classes.tiles}>
        <div className={classes.addTiles}>
          <button
            type="button"
            className={classes.tile}
            data-add
            onClick={() => pick(blankQuest(childKeys, null))}
          >
            <div className={classes.tileIcon}>✏️</div>
            <b>Make my own</b>
          </button>
          {offerOneOff && plan && (
            <button
              type="button"
              className={classes.tile}
              data-add
              onClick={() => pick(blankQuest(childKeys, plan.today))}
            >
              <div className={classes.tileIcon}>⚡</div>
              <b>One-off today</b>
            </button>
          )}
        </div>
        {(library.data ?? [])
          .filter((item) => !used.has(item.id))
          .map((item) => (
            <button
              key={item.id}
              type="button"
              className={classes.tile}
              onClick={() => pick({ ...choreFromLibrary(item, childKeys), key: newKey('lib') })}
            >
              <div className={classes.tileIcon}>{item.icon}</div>
              <b>{item.title}</b>
              <small>{item.basePoints} pts</small>
            </button>
          ))}
      </div>
    </Sheet>
  );
}
