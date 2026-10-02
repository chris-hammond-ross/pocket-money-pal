import {
  formatClock12,
  formatMoney,
  formatPaydayCountdown,
  PAYDAY_DAY_NAMES,
  PAYDAY_DAY_ORDER,
  PAYDAY_TIMES,
  rateCaption,
  type Jar,
  type MoneyOverview,
  type PhoneSettingsPatch,
  type SavingsRow,
} from '@pmp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../../lib/api';
import { clockTime } from '../../../lib/format';
import { sound } from '../../../lib/sounds';
import { PixelLabel } from '../../arcade';
import { problemText, useParentUi } from '../context';
import { GiftSheet, JarSheet, SpendSheet } from './MoneySheets';
import classes from './payday.module.css';

type Child = MoneyOverview['children'][number];
type SheetState =
  | { kind: 'gift'; childId: number }
  | { kind: 'spend'; childId: number }
  | { kind: 'jar'; childId: number; jarId: number | null };

/** The phone's clock as the server's, ticking each minute (for "in 3d 1h"). */
function useNow(offsetMs: number) {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offsetMs), 30_000);
    return () => clearInterval(timer);
  }, [offsetMs]);
  return now;
}

function useMoney() {
  return useQuery({
    queryKey: ['money'],
    queryFn: async () => {
      const sent = Date.now();
      const overview = await api.money();
      return { ...overview, clockOffsetMs: overview.serverNow - (sent + Date.now()) / 2 };
    },
  });
}

/**
 * The 💰 Payday tab (spec 004): what needs a grown-up (smashed jars, prices to check), the
 * next payday and its settings, each child's week, and a money page per child.
 */
export function PaydayTab() {
  const money = useMoney();
  const [childId, setChildId] = useState<number | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const data = money.data;
  if (!data) return null;
  const child = data.children.find((c) => c.id === childId);
  const sheetChild = sheet && data.children.find((c) => c.id === sheet.childId);

  return (
    <>
      {child ? (
        <PlayerMoney
          child={child}
          overview={data}
          onBack={() => {
            sound.tap();
            setChildId(null);
          }}
          onSheet={setSheet}
        />
      ) : (
        <>
          <NeedsYou players={data.children} currency={data.currency} onEdit={setSheet} />
          <PixelLabel>NEXT PAYDAY</PixelLabel>
          <NextPayday overview={data} />
          <PixelLabel>THIS WEEK</PixelLabel>
          {data.children.map((c) => (
            <button
              key={c.id}
              type="button"
              className={classes.childCard}
              style={{ '--c': c.colour } as CSSProperties}
              onClick={() => {
                sound.tap();
                setChildId(c.id);
              }}
            >
              <span className={classes.avatar}>{c.avatar}</span>
              <span className={classes.grow}>
                <b>{c.name}</b>
                <span className={classes.dim}>{weekLine(c, data.currency)}</span>
              </span>
              <span className={classes.saved}>
                <b>{formatMoney(c.money.savedCents, data.currency)}</b>
                <span className={classes.dim}>saved</span>
              </span>
            </button>
          ))}
          <p className={classes.rateLine}>
            ⭐ {rateCaption(data.centsPerPoint, data.currency)}. Points turn into money at payday;
            the kids pour it into their jars.
          </p>
        </>
      )}

      {sheet?.kind === 'gift' && sheetChild && (
        <GiftSheet child={sheetChild} currency={data.currency} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === 'spend' && sheetChild && (
        <SpendSheet child={sheetChild} currency={data.currency} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === 'jar' && sheetChild && (
        <JarSheet
          key={sheet.jarId ?? 'new'}
          child={sheetChild}
          jar={sheetChild.jars.find((j) => j.id === sheet.jarId) ?? null}
          currency={data.currency}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}

/** "115 pts waiting = £5.75 · 🪙 £1.25 to sort · 🍯 £36.00 in jars". */
function weekLine(c: Child, currency: string): string {
  const m = (cents: number) => formatMoney(cents, currency);
  const inJars = c.jars.reduce((sum, j) => sum + j.inCents, 0);
  return [
    `${c.money.unconvertedPoints} pts waiting = ${m(Math.max(0, c.money.unconvertedCents))}`,
    `🪙 ${m(c.money.toSortCents)} to sort`,
    `🍯 ${m(inJars)} in jars`,
  ].join(' · ');
}

// ---------------------------------------------------------------------------
// NEEDS YOU

function NeedsYou({
  players,
  currency,
  onEdit,
  only,
}: {
  players: Child[];
  currency: string;
  onEdit: (sheet: SheetState) => void;
  /** Only this child's cards (on their money page). */
  only?: number;
}) {
  const ui = useParentUi();
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: async ({ action, jar }: { action: 'bought' | 'back' | 'ok'; jar: Jar }) => {
      if (action === 'bought') await api.buyGoal(jar.id);
      else if (action === 'back') await api.unsmashGoal(jar.id);
      else await api.updateGoal(jar.id, {});
    },
    onSuccess: (_, { action }) => {
      if (action === 'bought') sound.fanfare();
      else sound.pop();
      void queryClient.invalidateQueries({ queryKey: ['money'] });
    },
    onError: (err) => {
      sound.sad();
      ui.notify({ icon: '⚠️', title: 'That didn’t work', body: problemText(err), tone: 'error' });
    },
  });
  const m = (cents: number) => formatMoney(cents, currency);
  const cards = players
    .filter((c) => only === undefined || c.id === only)
    .flatMap((c) =>
      c.jars
        .filter((j) => j.smashed || (j.madeByChild && !j.priceChecked))
        .map((jar) => ({ child: c, jar })),
    );
  if (cards.length === 0) return null;

  return (
    <>
      <PixelLabel>NEEDS YOU</PixelLabel>
      {cards.map(({ child, jar }) =>
        jar.smashed ? (
          <div key={jar.id} className={classes.needCard}>
            <div className={classes.needRow}>
              <span>{jar.emoji}</span>
              <span className={classes.grow}>
                <b>
                  {child.name} smashed the {jar.name} jar
                </b>
                <span className={classes.dim}>{m(jar.inCents)} ready · needs buying</span>
              </span>
            </div>
            <div className={classes.twoButtons}>
              <button
                type="button"
                className={classes.button}
                data-tone="green"
                disabled={act.isPending}
                onClick={() => act.mutate({ action: 'bought', jar })}
              >
                ✓ Bought it
              </button>
              <button
                type="button"
                className={classes.button}
                data-tone="ghost"
                disabled={act.isPending}
                onClick={() => act.mutate({ action: 'back', jar })}
              >
                ↩ Put it back
              </button>
            </div>
          </div>
        ) : (
          <div key={jar.id} className={classes.needCard}>
            <div className={classes.needRow}>
              <span>{jar.emoji}</span>
              <span className={classes.grow}>
                <b>
                  {child.name} made a jar: {jar.name}
                </b>
                <span className={classes.dim}>They set {m(jar.targetCents)} · is that right?</span>
              </span>
            </div>
            <div className={classes.twoButtons}>
              <button
                type="button"
                className={classes.button}
                data-tone="green"
                disabled={act.isPending}
                onClick={() => act.mutate({ action: 'ok', jar })}
              >
                ✓ Looks right
              </button>
              <button
                type="button"
                className={classes.button}
                data-tone="ghost"
                onClick={() => {
                  sound.tap();
                  onEdit({ kind: 'jar', childId: child.id, jarId: jar.id });
                }}
              >
                Edit price
              </button>
            </div>
          </div>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// NEXT PAYDAY

function NextPayday({ overview }: { overview: MoneyOverview & { clockOffsetMs: number } }) {
  const ui = useParentUi();
  const queryClient = useQueryClient();
  const now = useNow(overview.clockOffsetMs);
  const [confirming, setConfirming] = useState(false);
  const { payday } = overview;
  const waiting = payday.waitingSlot !== null;

  // Show the chosen time in its row of chips (6pm is off to the right).
  const timeChips = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = timeChips.current;
    const chip = row?.querySelector<HTMLElement>(`[data-time="${payday.time}"]`);
    if (row && chip) row.scrollLeft = chip.offsetLeft - row.offsetLeft - 60;
  }, [payday.time]);

  const save = useMutation({
    mutationFn: (patch: PhoneSettingsPatch) => api.updateSettings(patch),
    onSuccess: () => {
      sound.pop();
      void queryClient.invalidateQueries({ queryKey: ['money'] });
    },
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Not saved', body: problemText(err), tone: 'error' }),
  });
  const start = useMutation({
    mutationFn: api.startPayday,
    onSuccess: () => {
      sound.fanfare();
      setConfirming(false);
      ui.notify({ icon: '💰', title: 'Payday!', body: 'The show is on the kiosk now.' });
      void queryClient.invalidateQueries({ queryKey: ['money'] });
    },
    onError: (err) => {
      sound.sad();
      setConfirming(false);
      ui.notify({
        icon: '⚠️',
        title: 'Payday didn’t start',
        body: problemText(err),
        tone: 'error',
      });
    },
  });

  return (
    <div className={classes.card}>
      <div className={classes.nextHead}>
        <span>💰</span>
        <div>
          <b>
            {PAYDAY_DAY_NAMES[payday.day]} · {clockTime(payday.time)}
          </b>
          <span className={classes.dim}>
            {waiting
              ? 'It’s payday! Start it when the kids are ready'
              : `in ${formatPaydayCountdown(payday.nextAt - now)}`}
          </span>
        </div>
      </div>

      <span className={classes.fieldLabel}>Day</span>
      <div className={classes.scrollChips}>
        {PAYDAY_DAY_ORDER.map((day) => (
          <button
            key={day}
            type="button"
            data-on={payday.day === day || undefined}
            disabled={save.isPending}
            onClick={() => save.mutate({ paydayDay: day })}
          >
            {PAYDAY_DAY_NAMES[day]}
          </button>
        ))}
      </div>
      <span className={classes.fieldLabel}>Time</span>
      <div className={classes.scrollChips} ref={timeChips}>
        {PAYDAY_TIMES.map((time) => (
          <button
            key={time}
            type="button"
            data-on={payday.time === time || undefined}
            data-time={time}
            disabled={save.isPending}
            onClick={() => save.mutate({ paydayTime: time })}
          >
            {formatClock12(time)}
          </button>
        ))}
      </div>
      <span className={classes.fieldLabel}>How it starts</span>
      <div className={classes.chips}>
        <button
          type="button"
          data-on={payday.auto || undefined}
          onClick={() => save.mutate({ paydayAuto: true })}
        >
          ⏰ By itself on the kiosk
        </button>
        <button
          type="button"
          data-on={!payday.auto || undefined}
          onClick={() => save.mutate({ paydayAuto: false })}
        >
          🙋 When I press start
        </button>
      </div>

      {confirming ? (
        <div className={classes.confirm}>
          {waiting
            ? 'Start payday now? The show plays on the kiosk.'
            : `Start payday now? It counts as this week’s, so ${PAYDAY_DAY_NAMES[payday.day]}’s payday is skipped.`}
          <div className={classes.twoButtons}>
            <button
              type="button"
              className={classes.button}
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              ▶ Start it
            </button>
            <button
              type="button"
              className={classes.button}
              data-tone="ghost"
              onClick={() => setConfirming(false)}
            >
              Not yet
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={classes.startButton}
          data-waiting={waiting || undefined}
          onClick={() => {
            sound.tap();
            setConfirming(true);
          }}
        >
          ▶ Start payday now
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A player's money page

function PlayerMoney({
  child,
  overview,
  onBack,
  onSheet,
}: {
  child: Child;
  overview: MoneyOverview;
  onBack: () => void;
  onSheet: (sheet: SheetState) => void;
}) {
  const { currency } = overview;
  const m = (cents: number) => formatMoney(cents, currency);
  const book = useQuery({ queryKey: ['savings', child.id], queryFn: () => api.savings(child.id) });

  return (
    <>
      <button type="button" className={classes.back} onClick={onBack}>
        ‹ Payday
      </button>
      <div className={classes.card} style={{ '--c': child.colour } as CSSProperties}>
        <div className={classes.needRow}>
          <span className={classes.avatar}>{child.avatar}</span>
          <span className={classes.grow}>
            <b style={{ fontSize: 20 }}>{child.name}</b>
            <span className={classes.dim}>
              {child.money.unconvertedPoints} pts waiting · 🪙 {m(child.money.toSortCents)} to sort
            </span>
          </span>
          <span className={classes.saved}>
            <b style={{ fontSize: 26 }}>{m(child.money.savedCents)}</b>
          </span>
        </div>
        <div className={classes.twoButtons}>
          <button
            type="button"
            className={classes.button}
            data-tone="green"
            onClick={() => {
              sound.tap();
              onSheet({ kind: 'gift', childId: child.id });
            }}
          >
            🎁 Gift
          </button>
          <button
            type="button"
            className={classes.button}
            onClick={() => {
              sound.tap();
              onSheet({ kind: 'spend', childId: child.id });
            }}
          >
            🛒 Spent
          </button>
        </div>
      </div>

      <NeedsYou players={[child]} currency={currency} onEdit={onSheet} only={child.id} />

      <PixelLabel
        right={
          <button
            type="button"
            className={classes.newButton}
            data-tone="ghost"
            onClick={() => {
              sound.tap();
              onSheet({ kind: 'jar', childId: child.id, jarId: null });
            }}
          >
            + New
          </button>
        }
      >
        JARS
      </PixelLabel>
      <div className={classes.card}>
        {child.jars.length === 0 && <div className={classes.empty}>No jars yet.</div>}
        {child.jars.map((jar) => (
          <button
            key={jar.id}
            type="button"
            className={classes.jarRow}
            style={{ '--c': child.colour } as CSSProperties}
            onClick={() => {
              sound.tap();
              onSheet({ kind: 'jar', childId: child.id, jarId: jar.id });
            }}
          >
            <span className={classes.jarPic}>
              {jar.imageUrl ? <img src={jar.imageUrl} alt="" /> : jar.emoji}
            </span>
            <span className={classes.grow}>
              <b>
                {jar.name}
                {jar.madeByChild && <span className={classes.tag}>made by {child.name}</span>}
                {jar.smashed && <span className={classes.tag}>🔨 smashed</span>}
              </b>
              <span className={classes.bar}>
                <i style={{ width: `${Math.min(100, (jar.inCents / jar.targetCents) * 100)}%` }} />
              </span>
              <span className={classes.dim}>{m(jar.inCents)} in the jar</span>
            </span>
            <span className={classes.price}>{m(jar.targetCents)}</span>
          </button>
        ))}
      </div>

      <PixelLabel>SAVINGS BOOK</PixelLabel>
      <div className={classes.card}>
        {book.data?.rows.length === 0 && (
          <div className={classes.empty}>Nothing yet. The first payday starts the book.</div>
        )}
        {book.data?.rows.map((row) => (
          <BookRow key={row.id} row={row} currency={currency} timezone={overview.timezone} />
        ))}
      </div>
    </>
  );
}

const ROW_ICONS: Record<SavingsRow['kind'], string> = {
  payday: '💰',
  gift: '🎁',
  spend: '🛒',
  bought: '🏆',
};

function BookRow({
  row,
  currency,
  timezone,
}: {
  row: SavingsRow;
  currency: string;
  timezone: string;
}) {
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(row.kind === 'payday' ? row.dateAt : row.at);
  const title =
    row.kind === 'payday'
      ? 'Payday'
      : row.kind === 'bought'
        ? `Bought: ${row.jar?.emoji ?? ''} ${row.jar?.name ?? row.note ?? ''}`
        : (row.note ?? '');
  const detail = [
    date,
    row.kind === 'payday' && row.points !== null ? `${row.points} pts` : null,
    row.jar && row.kind === 'spend' ? `from the ${row.jar.name} jar` : null,
    row.by,
  ]
    .filter(Boolean)
    .join(' · ');
  const amount = formatMoney(Math.abs(row.cents), currency);
  return (
    <div className={classes.bookRow}>
      <span>{ROW_ICONS[row.kind]}</span>
      <span className={classes.grow}>
        {title}
        <span className={classes.dim}>{detail}</span>
      </span>
      <span className={row.cents < 0 ? classes.minus : classes.plus}>
        {row.cents < 0 ? `−${amount}` : `+${amount}`}
      </span>
    </div>
  );
}
