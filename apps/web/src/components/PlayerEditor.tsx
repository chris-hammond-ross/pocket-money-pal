import { AVATAR_CHOICES, COLOUR_CHOICES, childInputSchema, type ChildInput } from '@pmp/shared';
import { useState, type CSSProperties } from 'react';
import { celebrate } from '../lib/confetti';
import { sound } from '../lib/sounds';
import { ArcadeButton, CloseButton, Sheet } from './arcade';
import classes from './PlayerEditor.module.css';

const MIN_AGE = 3;
const MAX_AGE = 17;

/**
 * The player editor (spec 003): avatar carousel, name, age stepper and colour swatches.
 * "▶ READY!" for a new player (fanfare and confetti in their colour), "💾 Save" otherwise,
 * and "Remove player" behind a second tap.
 */
export function PlayerEditor({
  opened,
  player,
  isNew,
  takenNames,
  onSave,
  onRemove,
  onClose,
}: {
  opened: boolean;
  player: ChildInput;
  isNew: boolean;
  /** Other players' names, for "each child's name is unique". */
  takenNames: string[];
  onSave: (player: ChildInput) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const [p, setP] = useState(player);
  const [spin, setSpin] = useState(0);
  const [armed, setArmed] = useState(false);

  const nameTaken = takenNames.some(
    (n) => n.toLocaleLowerCase() === p.name.trim().toLocaleLowerCase(),
  );
  const valid = childInputSchema.safeParse(p).success && !nameTaken;

  const cycleAvatar = (by: number) => {
    const i = AVATAR_CHOICES.indexOf(p.avatar as (typeof AVATAR_CHOICES)[number]);
    const next = AVATAR_CHOICES[(i + by + AVATAR_CHOICES.length) % AVATAR_CHOICES.length]!;
    setP({ ...p, avatar: next });
    setSpin((s) => s + 1);
    sound.pop();
  };

  const save = () => {
    if (!valid) return;
    onSave({ ...p, name: p.name.trim() });
    if (isNew) {
      sound.fanfare();
      celebrate({ colours: [p.colour, '#ffd43b'], y: 0.4, count: 70 });
    } else {
      sound.pop();
    }
  };

  return (
    <Sheet
      opened={opened}
      onClose={onClose}
      colour={p.colour}
      head={
        <>
          <span className={`pixel ${classes.heading}`}>
            {isNew ? 'CREATE PLAYER' : 'EDIT PLAYER'}
          </span>
          <CloseButton onClick={onClose} />
        </>
      }
      footer={
        <ArcadeButton disabled={!valid} onClick={save}>
          {isNew ? '▶ READY!' : '💾 Save'}
        </ArcadeButton>
      }
    >
      <div className={classes.editor} style={{ '--c': p.colour } as CSSProperties}>
        <div className={classes.carousel}>
          <button type="button" onClick={() => cycleAvatar(-1)} aria-label="Previous avatar">
            ‹
          </button>
          <div key={spin} className={classes.avatar}>
            {p.avatar}
          </div>
          <button type="button" onClick={() => cycleAvatar(1)} aria-label="Next avatar">
            ›
          </button>
        </div>

        <input
          className={classes.name}
          placeholder="Name"
          value={p.name}
          maxLength={14}
          autoComplete="off"
          onChange={(e) => setP({ ...p, name: e.target.value })}
        />
        {nameTaken && <p className={classes.error}>Another player already has that name.</p>}

        <div className={classes.age}>
          <button
            type="button"
            aria-label="Younger"
            disabled={p.age <= MIN_AGE}
            onClick={() => {
              setP({ ...p, age: p.age - 1 });
              sound.tap();
            }}
          >
            −
          </button>
          <div>
            <small>AGE</small>
            <b className="pixel">{p.age}</b>
          </div>
          <button
            type="button"
            aria-label="Older"
            disabled={p.age >= MAX_AGE}
            onClick={() => {
              setP({ ...p, age: p.age + 1 });
              sound.tap();
            }}
          >
            +
          </button>
        </div>

        <div className={classes.swatches}>
          {COLOUR_CHOICES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              data-on={c === p.colour || undefined}
              style={{ background: c }}
              onClick={() => {
                setP({ ...p, colour: c });
                sound.tap();
              }}
            />
          ))}
        </div>

        {onRemove && (
          <ArcadeButton
            tone="red"
            size="small"
            className={classes.remove}
            onClick={() => {
              if (armed) onRemove();
              else {
                setArmed(true);
                sound.sad();
              }
            }}
          >
            {armed ? 'Tap again to remove' : 'Remove player'}
          </ArcadeButton>
        )}
      </div>
    </Sheet>
  );
}
