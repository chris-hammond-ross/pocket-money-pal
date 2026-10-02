/** The setup stages (spec 003, "First-run setup"). State lives in SetupFlow. */
import {
  LIBRARY_SECTIONS,
  choreRunsOn,
  parseTimeOfDay,
  pointsRange,
  weekdayOf,
  zonedTimeOf,
  type ChoreLibraryItem,
  type SetupChild,
  type SetupChore,
} from '@pmp/shared';
import type { CSSProperties } from 'react';
import {
  DayAxis,
  DashedButton,
  PixelLabel,
  PlayerBadge,
  RateSlider,
  WindowBar,
} from '../../components/arcade';
import { DAY_SHORT } from '../../lib/format';
import { sound } from '../../lib/sounds';
import classes from './setup.module.css';

export function TitleStage() {
  return (
    <div className={classes.title}>
      <div className={classes.logo}>🐷</div>
      <h1>
        POCKET
        <br />
        MONEY PAL
      </h1>
      <p>Let’s build your family’s quest board. It takes about 3 minutes.</p>
      <p className={classes.blink}>PRESS START</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1 · Game masters

export function MastersStage({
  names,
  duplicateName,
  onName,
  onAdd,
  onRemove,
  canAdd,
}: {
  names: string[];
  duplicateName: boolean;
  onName: (i: number, name: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  canAdd: boolean;
}) {
  return (
    <>
      {names.map((name, i) => (
        <div key={i} className={classes.gmRow}>
          <div className={classes.gmTop}>
            <span>🧙</span>
            <input
              className={classes.textInput}
              placeholder={i ? 'e.g. Dad' : 'Your name, e.g. Mum'}
              value={name}
              maxLength={30}
              autoComplete="off"
              aria-label={`Grown-up ${i + 1} name`}
              onChange={(e) => onName(i, e.target.value)}
            />
            {i > 0 && (
              <button
                type="button"
                className={classes.removeRow}
                aria-label="Remove grown-up"
                onClick={() => onRemove(i)}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ))}
      {canAdd && <DashedButton onClick={onAdd}>＋ Another grown-up</DashedButton>}
      {duplicateName && <p className={classes.error}>Each grown-up needs a different name.</p>}
    </>
  );
}

// ---------------------------------------------------------------------------
// 2 · Player select

export function PlayersStage({
  players,
  onEdit,
  onAdd,
}: {
  players: SetupChild[];
  onEdit: (key: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className={classes.roster}>
      {players.map((p) => (
        <button
          key={p.key}
          type="button"
          className={classes.slot}
          style={{ '--c': p.colour } as CSSProperties}
          onClick={() => onEdit(p.key)}
        >
          <div className={classes.slotAvatar}>{p.avatar}</div>
          <b>{p.name}</b>
          <small>Age {p.age}</small>
        </button>
      ))}
      <button type="button" className={`${classes.slot} ${classes.slotAdd}`} onClick={onAdd}>
        <div className={classes.slotAvatar}>＋</div>
        NEW
        <br />
        PLAYER
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3 · Hand out quests

function Dots({ keys, players }: { keys: string[]; players: SetupChild[] }) {
  return (
    <div className={classes.dots}>
      {keys.map((k) => (
        <i key={k} style={{ background: players.find((p) => p.key === k)?.colour }} />
      ))}
    </div>
  );
}

export function QuestsStage({
  players,
  selected,
  chores,
  library,
  onSelect,
  onToggle,
  onMakeOwn,
}: {
  players: SetupChild[];
  selected: SetupChild;
  chores: SetupChore[];
  library: ChoreLibraryItem[];
  onSelect: (key: string) => void;
  onToggle: (tile: ChoreLibraryItem | string) => void;
  onMakeOwn: () => void;
}) {
  const count = (key: string) => chores.filter((c) => c.childKeys.includes(key)).length;
  const own = chores.filter((c) => c.libraryId === null);
  const tileStyle = { '--c': selected.colour } as CSSProperties;

  return (
    <>
      <div className={classes.playerTabs}>
        {players.map((p) => (
          <button
            key={p.key}
            type="button"
            data-on={p.key === selected.key || undefined}
            style={{ '--c': p.colour } as CSSProperties}
            onClick={() => {
              onSelect(p.key);
              sound.tap();
            }}
          >
            <span>{p.avatar}</span>
            {p.name} <em>{count(p.key)}</em>
          </button>
        ))}
      </div>

      {LIBRARY_SECTIONS.map((section) => (
        <div key={section}>
          <div className={classes.section}>{section.toUpperCase()}</div>
          <div className={classes.tiles}>
            {library
              .filter((item) => item.section === section)
              .map((item) => {
                const chore = chores.find((c) => c.key === `lib:${item.id}`);
                const young = selected.age < item.minAge;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={classes.tile}
                    style={tileStyle}
                    data-mine={chore?.childKeys.includes(selected.key) || undefined}
                    data-young={young || undefined}
                    onClick={() => onToggle(item)}
                  >
                    <Dots keys={chore?.childKeys ?? []} players={players} />
                    <div className={classes.tileIcon}>{item.icon}</div>
                    <b>{item.title}</b>
                    <small>
                      {item.basePoints} pts{young && ` · ${item.minAge}+`}
                    </small>
                  </button>
                );
              })}
          </div>
        </div>
      ))}

      <div className={classes.section}>YOUR OWN</div>
      <div className={classes.tiles}>
        {own.map((c) => (
          <button
            key={c.key}
            type="button"
            className={classes.tile}
            style={tileStyle}
            data-mine={c.childKeys.includes(selected.key) || undefined}
            onClick={() => onToggle(c.key!)}
          >
            <Dots keys={c.childKeys} players={players} />
            <div className={classes.tileIcon}>{c.icon}</div>
            <b>{c.title}</b>
            <small>{c.basePoints} pts</small>
          </button>
        ))}
        <button type="button" className={`${classes.tile} ${classes.tileAdd}`} onClick={onMakeOwn}>
          <div className={classes.tileIcon}>✏️</div>
          <b>Make my own</b>
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 4 · Today's board

export function BoardStage({
  today,
  now,
  timeZone,
  chores,
  players,
  centsPerPoint,
  currency,
  onEdit,
  onRate,
}: {
  today: string;
  now: number;
  timeZone: string;
  chores: SetupChore[];
  players: SetupChild[];
  centsPerPoint: number;
  currency: string;
  onEdit: (key: string) => void;
  onRate: (cents: number) => void;
}) {
  const todays = chores
    .filter((c) => choreRunsOn(c, today))
    .sort((a, b) => parseTimeOfDay(a.dueBy) - parseTimeOfDay(b.dueBy));
  const nowMinutes = parseTimeOfDay(zonedTimeOf(now, timeZone));

  return (
    <>
      <DayAxis />
      {todays.map((c) => {
        const range = pointsRange(c);
        return (
          <button
            key={c.key}
            type="button"
            className={classes.quest}
            onClick={() => onEdit(c.key!)}
          >
            <div className={classes.questHead}>
              <span className={classes.questIcon}>{c.icon}</span>
              <b>{c.title}</b>
              <span className={classes.who}>
                {c.childKeys.map((k) => {
                  const p = players.find((x) => x.key === k);
                  return p && <PlayerBadge key={k} avatar={p.avatar} colour={p.colour} />;
                })}
              </span>
              <span className={classes.points}>
                {range.onTime}–{range.max}
              </span>
            </div>
            <WindowBar times={c} nowMinutes={nowMinutes} />
          </button>
        );
      })}
      {todays.length === 0 && (
        <div className={classes.empty}>
          No quests on {DAY_SHORT[weekdayOf(today)]}. Your {chores.length} quest
          {chores.length === 1 ? '' : 's'} start on their own days.
        </div>
      )}

      <PixelLabel>LOOT RATE</PixelLabel>
      <RateSlider
        value={centsPerPoint}
        currency={currency}
        onChange={(cents) => {
          onRate(cents);
          sound.tick();
        }}
      />
    </>
  );
}
