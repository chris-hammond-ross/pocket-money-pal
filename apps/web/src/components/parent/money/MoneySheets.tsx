import {
  formatMoney,
  GIFT_AMOUNTS,
  GIFT_NOTES,
  JAR_EMOJI_LIST,
  JAR_MAX_CENTS,
  JAR_MIN_CENTS,
  JAR_NAME_MAX,
  keypadCents,
  NOTE_MAX,
  parseMoneyInput,
  SPEND_NOTES,
  type Jar,
  type MoneyOverview,
} from '@pmp/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { sound } from '../../../lib/sounds';
import { Sheet } from '../../arcade';
import { problemText, useParentUi } from '../context';
import parentClasses from '../parent.module.css';
import classes from './payday.module.css';

type Child = MoneyOverview['children'][number];

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];

/** The money keypad: digits push in from the right, like a till (£20.00 is 2-0-0-0). */
function Keypad({ cents, onChange }: { cents: number; onChange: (cents: number) => void }) {
  return (
    <div className={classes.keypad}>
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          aria-label={key === 'back' ? 'Delete' : key}
          onClick={() => {
            sound.tap();
            onChange(keypadCents(cents, key));
          }}
        >
          {key === 'back' ? '⌫' : key}
        </button>
      ))}
    </div>
  );
}

function NoteField({
  value,
  chips,
  onChange,
}: {
  value: string;
  chips: readonly string[];
  onChange: (note: string) => void;
}) {
  return (
    <>
      <div className={classes.chips}>
        {chips.map((note) => (
          <button
            key={note}
            type="button"
            data-on={value === note || undefined}
            onClick={() => {
              sound.tap();
              onChange(note);
            }}
          >
            {note}
          </button>
        ))}
      </div>
      <input
        className={classes.input}
        style={{ marginTop: 8 }}
        value={value}
        maxLength={NOTE_MAX}
        placeholder="Or type a note"
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );
}

function useMoneyMutation<T>(
  fn: (input: T) => Promise<unknown>,
  done: () => void,
  failTitle: string,
) {
  const ui = useParentUi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['money'] });
      void queryClient.invalidateQueries({ queryKey: ['savings'] });
      done();
    },
    onError: (err) => {
      sound.sad();
      ui.notify({ icon: '⚠️', title: failTitle, body: problemText(err), tone: 'error' });
    },
  });
}

/** 🎁 Gift (money in): it arrives on the kiosk as an envelope (spec 004). */
export function GiftSheet({
  child,
  currency,
  onClose,
}: {
  child: Child;
  currency: string;
  onClose: () => void;
}) {
  const ui = useParentUi();
  const [cents, setCents] = useState(0);
  const [note, setNote] = useState<string>(GIFT_NOTES[0]!.note);
  const send = useMoneyMutation(
    () => api.sendEnvelope(child.id, { cents, note: note.trim() }),
    () => {
      sound.coin();
      ui.notify({
        icon: '✉️',
        title: `Envelope sent to ${child.name}`,
        body: `${formatMoney(cents, currency)} is waiting on the kiosk.`,
      });
      onClose();
    },
    'Envelope not sent',
  );
  const ready = cents > 0 && note.trim().length > 0 && !send.isPending;
  return (
    <Sheet
      opened
      onClose={onClose}
      colour={child.colour}
      head={<span className={parentClasses.sheetTitle}>🎁 Gift for {child.name}</span>}
      footer={
        <button
          type="button"
          className={classes.button}
          data-tone="green"
          disabled={!ready}
          onClick={() => send.mutate(undefined)}
        >
          ✉️ Send the envelope
        </button>
      }
    >
      <div className={classes.amount}>{formatMoney(cents, currency)}</div>
      <div className={classes.chips} style={{ justifyContent: 'center', marginBottom: 10 }}>
        {GIFT_AMOUNTS.map((a) => (
          <button
            key={a}
            type="button"
            data-on={cents === a || undefined}
            onClick={() => {
              sound.tap();
              setCents(a);
            }}
          >
            {formatMoney(a, currency).replace(/\.00$/, '')}
          </button>
        ))}
      </div>
      <Keypad cents={cents} onChange={setCents} />
      <span className={classes.fieldLabel}>What’s it for?</span>
      <NoteField value={note} chips={GIFT_NOTES.map((g) => g.note)} onChange={setNote} />
    </Sheet>
  );
}

/** 🛒 Spent (money out): from "to sort" or a jar, never more than is there. */
export function SpendSheet({
  child,
  currency,
  onClose,
}: {
  child: Child;
  currency: string;
  onClose: () => void;
}) {
  const ui = useParentUi();
  const [cents, setCents] = useState(0);
  const [note, setNote] = useState<string>(SPEND_NOTES[0]);
  const [from, setFrom] = useState<number | null>(null);
  const jars = child.jars.filter((j) => j.inCents > 0 && !j.smashed);
  const source = from === null ? null : jars.find((j) => j.id === from);
  const available = source ? source.inCents : child.money.toSortCents;
  const m = (c: number) => formatMoney(c, currency);
  const spend = useMoneyMutation(
    () => api.spend(child.id, { cents, note: note.trim(), goalId: source?.id ?? null }),
    () => {
      sound.pop();
      ui.notify({
        icon: '🛒',
        title: `${note.trim()}: −${m(cents)}`,
        body: `From ${child.name}’s savings.`,
      });
      onClose();
    },
    'Not saved',
  );
  const tooMuch = cents > available;
  const ready = cents > 0 && !tooMuch && note.trim().length > 0 && !spend.isPending;
  return (
    <Sheet
      opened
      onClose={onClose}
      colour={child.colour}
      head={<span className={parentClasses.sheetTitle}>🛒 {child.name} spent</span>}
      footer={
        <button
          type="button"
          className={classes.button}
          disabled={!ready}
          onClick={() => spend.mutate(undefined)}
        >
          🛒 Take {m(cents)} out
        </button>
      }
    >
      <div className={classes.amount}>{m(cents)}</div>
      <Keypad cents={cents} onChange={setCents} />
      {tooMuch && <div className={classes.problem}>There’s only {m(available)} there.</div>}
      <span className={classes.fieldLabel}>What on?</span>
      <NoteField value={note} chips={SPEND_NOTES} onChange={setNote} />
      <span className={classes.fieldLabel}>Take it from</span>
      <div className={classes.chips}>
        <button type="button" data-on={from === null || undefined} onClick={() => setFrom(null)}>
          🪙 To sort {m(child.money.toSortCents)}
        </button>
        {jars.map((j) => (
          <button
            key={j.id}
            type="button"
            data-on={from === j.id || undefined}
            onClick={() => setFrom(j.id)}
          >
            {j.emoji} {j.name} {m(j.inCents)}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * The jar sheet (edit or new): picture, name, price and an optional shop link. Saving marks
 * the price checked; a price below what's in the jar sends the extra back to "to sort".
 * A smashed jar also offers ✓ Bought it and ↩ Put it back.
 */
export function JarSheet({
  child,
  jar,
  currency,
  onClose,
}: {
  child: Child;
  /** Null for a new jar. */
  jar: Jar | null;
  currency: string;
  onClose: () => void;
}) {
  const ui = useParentUi();
  const [emoji, setEmoji] = useState(jar?.emoji ?? '🎁');
  const [name, setName] = useState(jar?.name ?? '');
  const [price, setPrice] = useState(jar ? (jar.targetCents / 100).toFixed(2) : '');
  const [link, setLink] = useState(jar?.shopUrl ?? '');
  const [deleting, setDeleting] = useState(false);
  const m = (c: number) => formatMoney(c, currency);
  const cents = parseMoneyInput(price);
  const priceOk = cents !== null && cents >= JAR_MIN_CENTS && cents <= JAR_MAX_CENTS;
  const linkOk = link.trim() === '' || /^https?:\/\/\S+$/i.test(link.trim());

  const save = useMoneyMutation(
    async () => {
      const fields = {
        name: name.trim(),
        emoji,
        targetCents: cents!,
        shopUrl: link.trim() || null,
      };
      if (jar) await api.updateGoal(jar.id, fields);
      else await api.createGoal({ childId: child.id, ...fields });
    },
    () => {
      sound.coin();
      ui.notify({
        icon: emoji,
        title: jar ? 'Jar saved' : `New jar for ${child.name}`,
        body: link.trim() ? 'Looking for a picture from the shop link…' : undefined,
      });
      onClose();
    },
    'Jar not saved',
  );
  const remove = useMoneyMutation(
    () => api.deleteGoal(jar!.id),
    () => {
      sound.sad();
      ui.notify({
        icon: '🗑',
        title: `${jar!.name} jar deleted`,
        body: 'Its coins went back to “to sort”.',
      });
      onClose();
    },
    'Not deleted',
  );
  const bought = useMoneyMutation(
    () => api.buyGoal(jar!.id),
    () => {
      sound.fanfare();
      onClose();
    },
    'Not saved',
  );
  const putBack = useMoneyMutation(
    () => api.unsmashGoal(jar!.id),
    () => onClose(),
    'Not saved',
  );

  const ready = name.trim().length > 0 && priceOk && linkOk && !save.isPending;
  const lowered = jar && cents !== null && cents < jar.inCents;

  return (
    <Sheet
      opened
      onClose={onClose}
      colour={child.colour}
      head={
        <span className={parentClasses.sheetTitle}>
          {jar ? `${jar.emoji} ${jar.name}` : `New jar for ${child.name}`}
        </span>
      }
      footer={
        <div className={classes.sheetFoot}>
          <button
            type="button"
            className={classes.button}
            data-tone="green"
            disabled={!ready}
            onClick={() => save.mutate(undefined)}
          >
            {jar && !jar.priceChecked ? '✓ Save (price checked)' : '💾 Save'}
          </button>
          {jar &&
            (deleting ? (
              <button
                type="button"
                className={classes.button}
                data-tone="red"
                disabled={remove.isPending}
                onClick={() => remove.mutate(undefined)}
              >
                Tap again to delete (coins go back to “to sort”)
              </button>
            ) : (
              <button
                type="button"
                className={classes.button}
                data-tone="red"
                onClick={() => setDeleting(true)}
              >
                🗑 Delete jar
              </button>
            ))}
        </div>
      }
    >
      {jar?.smashed && (
        <div className={classes.needCard}>
          <b>🔨 Smashed · {m(jar.inCents)} ready · needs buying</b>
          <div className={classes.twoButtons}>
            <button
              type="button"
              className={classes.button}
              data-tone="green"
              onClick={() => bought.mutate(undefined)}
            >
              ✓ Bought it
            </button>
            <button
              type="button"
              className={classes.button}
              data-tone="ghost"
              onClick={() => putBack.mutate(undefined)}
            >
              ↩ Put it back
            </button>
          </div>
        </div>
      )}
      <span className={classes.fieldLabel}>Picture</span>
      <div className={classes.emojiRow}>
        {JAR_EMOJI_LIST.map((e) => (
          <button
            key={e}
            type="button"
            data-on={e === emoji || undefined}
            onClick={() => setEmoji(e)}
          >
            {e}
          </button>
        ))}
      </div>
      <span className={classes.fieldLabel}>Name</span>
      <input
        className={classes.input}
        value={name}
        maxLength={JAR_NAME_MAX}
        placeholder="What is it?"
        onChange={(e) => setName(e.target.value)}
      />
      <span className={classes.fieldLabel}>Price (£1 to £1,000)</span>
      <input
        className={classes.input}
        value={price}
        inputMode="decimal"
        placeholder="24.99"
        onChange={(e) => setPrice(e.target.value)}
      />
      {price !== '' && !priceOk && (
        <div className={classes.problem}>A price from £1.00 to £1,000.00, like 24.99.</div>
      )}
      {lowered && (
        <div className={classes.problem}>
          {m(jar.inCents - cents)} of what’s in the jar goes back to “to sort”.
        </div>
      )}
      <span className={classes.fieldLabel}>Shop link (optional, for a picture)</span>
      <input
        className={classes.input}
        value={link}
        inputMode="url"
        placeholder="https://…"
        onChange={(e) => setLink(e.target.value)}
      />
      {!linkOk && <div className={classes.problem}>A link starts with https://</div>}
      {jar && (
        <p className={classes.rateLine}>
          {m(jar.inCents)} in the jar{jar.madeByChild ? ` · made by ${child.name}` : ''}
        </p>
      )}
    </Sheet>
  );
}
