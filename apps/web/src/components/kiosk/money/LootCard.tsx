import {
  formatMoneyShort,
  formatPaydayWhen,
  isPaydaySoon,
  JARS_ON_BOARD,
  type Envelope,
  type KioskChild,
  type PaydayInfo,
} from '@pmp/shared';
import { Jar } from './Jar';
import classes from './money.module.css';
import { money, paydayCountdown } from './use-jar-money';

/**
 * The loot card at the bottom of a column (spec 004): the payday box with its countdown,
 * and the first four jars. Display only: tapping it opens the savings screen, and
 * "+ New jar" opens the new-jar screen. An unopened envelope wiggles above it.
 */
export function LootCard({
  child,
  payday,
  currency,
  timezone,
  now,
  onOpen,
  onNewJar,
  onEnvelope,
}: {
  child: KioskChild;
  payday: PaydayInfo;
  currency: string;
  timezone: string;
  now: number;
  onOpen: () => void;
  onNewJar: () => void;
  onEnvelope: (envelope: Envelope) => void;
}) {
  const countdown = paydayCountdown(payday, now);
  const soon = countdown !== null && isPaydaySoon(payday.nextAt - now);
  const shelf = child.jars.slice(0, JARS_ON_BOARD);
  const envelope = child.envelopes[0];

  return (
    <div className={classes.lootWrap}>
      {envelope && (
        <button type="button" className={classes.envelopeTag} onClick={() => onEnvelope(envelope)}>
          ✉️ From {envelope.fromName}! Tap to open
        </button>
      )}
      <div
        className={classes.loot}
        role="button"
        tabIndex={0}
        aria-label={`${child.name}'s savings`}
        onClick={onOpen}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      >
        <div className={classes.paydayBox} data-soon={soon || undefined} data-payday-box={child.id}>
          <div className={classes.paydayLabel}>💰 PAYDAY {countdown === null ? '' : 'IN'}</div>
          {countdown === null ? (
            <div className={classes.paydayWaiting}>Ask a grown-up!</div>
          ) : (
            <div className={classes.paydayCountdown}>{countdown}</div>
          )}
          <div className={classes.paydayWhen}>
            {formatPaydayWhen(payday.waitingSlot ?? payday.nextAt, timezone)}
          </div>
          {child.money.toSortCents > 0 && (
            <div className={classes.toSortChip}>
              🪙 {money(child.money.toSortCents, currency)} to sort
            </div>
          )}
        </div>
        <div className={classes.shelf}>
          {shelf.map((jar) => {
            const { full, big, nextMilestoneCents } = jar.progress;
            return (
              <div key={jar.id} className={classes.shelfJar} data-full={full || undefined}>
                <Jar
                  fill={jar.progress.fill}
                  emoji={jar.emoji}
                  colour={child.colour}
                  width={36}
                  glow={full}
                />
                <div className={classes.shelfName}>{jar.name}</div>
                <div className={classes.shelfAmount}>
                  {jar.smashed ? (
                    <span className={classes.full}>🛍️ Getting it!</span>
                  ) : full ? (
                    <span className={classes.full}>✓ Full! Smash it</span>
                  ) : big && nextMilestoneCents !== null ? (
                    <>
                      <b>{money(jar.inCents, currency)}</b> → ⭐{' '}
                      {formatMoneyShort(nextMilestoneCents, currency)}
                    </>
                  ) : (
                    <>
                      <b>{money(jar.inCents, currency)}</b> /{' '}
                      {formatMoneyShort(jar.targetCents, currency)}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {shelf.length < JARS_ON_BOARD && (
            <button
              type="button"
              className={classes.newJarTile}
              onClick={(e) => {
                e.stopPropagation();
                onNewJar();
              }}
            >
              <span>+</span>
              New jar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
