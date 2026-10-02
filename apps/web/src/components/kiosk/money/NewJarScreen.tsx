import {
  JAR_EMOJI,
  JAR_EMOJI_LIST,
  JAR_NAME_MAX,
  NEW_JAR_DEFAULT_CENTS,
  NEW_JAR_QUICK_PRICES,
  stepPrice,
  type KioskChild,
} from '@pmp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useState, type CSSProperties } from 'react';
import { api } from '../../../lib/api';
import { celebrate } from '../../../lib/confetti';
import { sound } from '../../../lib/sounds';
import { arcade } from '../../../theme';
import classes from './money.module.css';
import { useIdleClose } from './SavingsScreen';
import { money } from './use-jar-money';

/**
 * "+ New jar" on the kiosk (spec 004): pick a picture, name it, set the price. It goes to
 * the end of the jars, empty, and a grown-up checks the price on their phone.
 */
export function NewJarScreen({
  child,
  currency,
  onClose,
}: {
  child: KioskChild;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [emoji, setEmoji] = useState('🎁');
  const [name, setName] = useState('');
  const [price, setPrice] = useState(NEW_JAR_DEFAULT_CENTS);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useIdleClose(onClose, 120_000);

  const trimmed = name.trim();
  const ready = trimmed.length > 0 && !busy;
  const short = (cents: number) => money(cents, currency).replace(/\.00$/, '');

  const make = async () => {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.createGoal({ childId: child.id, name: trimmed, emoji, targetCents: price });
      sound.fanfare();
      celebrate({ colours: [child.colour, arcade.gold, '#ffffff'] });
      await queryClient.invalidateQueries({ queryKey: ['kiosk-today'] });
      onClose();
    } catch {
      sound.sad();
      setProblem('That didn’t work. Try again!');
      setBusy(false);
    }
  };

  return (
    <motion.div
      className={classes.overlay}
      style={{ '--c': child.colour, zIndex: 240 } as CSSProperties}
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 30 }}
      transition={{ duration: 0.2 }}
    >
      <header className={classes.overlayHead}>
        <div className={classes.overlayAvatar}>{child.avatar}</div>
        <div>
          <h2>NEW JAR</h2>
          <p>Make a new jar to save into</p>
        </div>
        <button type="button" className={classes.backButton} onClick={onClose}>
          ✕ Cancel
        </button>
      </header>

      <div className={classes.newJarBody}>
        <section className={classes.panel}>
          <h3 className={classes.stepLabel}>1 · PICK A PICTURE</h3>
          <div className={classes.emojiGrid}>
            {JAR_EMOJI_LIST.map((e) => (
              <button
                key={e}
                type="button"
                data-on={e === emoji || undefined}
                onClick={() => {
                  sound.tap();
                  setEmoji(e);
                }}
              >
                {e}
              </button>
            ))}
          </div>
          <h3 className={classes.stepLabel}>2 · WHAT IS IT?</h3>
          <input
            className={classes.nameInput}
            value={name}
            maxLength={JAR_NAME_MAX}
            placeholder="Type its name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void make()}
          />
          <div className={classes.chipsLeft}>
            {(JAR_EMOJI[emoji] ?? []).map((idea) => (
              <button
                key={idea}
                type="button"
                data-on={trimmed === idea || undefined}
                onClick={() => {
                  sound.tap();
                  setName(idea);
                }}
              >
                {idea}
              </button>
            ))}
          </div>
        </section>

        <section className={classes.panel}>
          <h3 className={classes.stepLabel}>3 · HOW MUCH DOES IT COST?</h3>
          <div className={classes.priceRow}>
            <button
              type="button"
              className={classes.priceButton}
              onClick={() => {
                sound.tap();
                setPrice((p) => stepPrice(p, -1));
              }}
              aria-label="Cheaper"
            >
              −
            </button>
            <b>{money(price, currency)}</b>
            <button
              type="button"
              className={classes.priceButton}
              onClick={() => {
                sound.tap();
                setPrice((p) => stepPrice(p, 1));
              }}
              aria-label="Dearer"
            >
              +
            </button>
          </div>
          <div className={classes.chips}>
            {NEW_JAR_QUICK_PRICES.map((p) => (
              <button
                key={p}
                type="button"
                data-on={price === p || undefined}
                onClick={() => {
                  sound.pop();
                  setPrice(p);
                }}
              >
                {short(p)}
              </button>
            ))}
          </div>
          <div className={classes.preview}>
            <div>{emoji}</div>
            <b>{trimmed || 'Type its name'}</b>
            <span>{money(price, currency)}</span>
          </div>
          {problem && <div className={classes.problem}>{problem}</div>}
          <button
            type="button"
            className={classes.actionButton}
            disabled={!ready}
            onClick={() => void make()}
          >
            ✨ Make my jar
          </button>
        </section>
      </div>
    </motion.div>
  );
}
