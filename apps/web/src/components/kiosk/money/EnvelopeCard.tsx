import type { Envelope, KioskChild } from '@pmp/shared';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../../lib/api';
import { celebrate } from '../../../lib/confetti';
import { sound } from '../../../lib/sounds';
import { arcade } from '../../../theme';
import classes from './money.module.css';
import { money } from './use-jar-money';

/**
 * A gift envelope, opened (spec 004): the card shows with a cha-ching and confetti, and
 * the money goes to "to sort" on the server. From here the child can go and pour it.
 */
export function EnvelopeCard({
  envelope,
  child,
  currency,
  onClose,
  onToJars,
}: {
  envelope: Envelope;
  child: KioskChild;
  currency: string;
  onClose: () => void;
  onToJars: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    api.openEnvelope(envelope.id).then(
      () => {
        sound.chaching();
        sound.chime();
        celebrate({ colours: [child.colour, arcade.gold, '#ffffff'], count: 160 });
      },
      () => {
        sound.sad();
        setFailed(true);
      },
    );
  }, [envelope.id, child.colour]);

  useEffect(() => {
    const t = setTimeout(onClose, 30_000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <motion.div
      className={classes.envelopeOverlay}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className={classes.envelopeCard}
        style={{ '--c': child.colour } as CSSProperties}
        initial={{ scale: 0.4, rotate: -8, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 16 }}
      >
        <div className={classes.envelopeIcon}>💌</div>
        <div className={classes.envelopeFrom}>From {envelope.fromName}!</div>
        {/* "👵 From Grandma" would only say the line above again. */}
        {!envelope.note.includes(envelope.fromName) && (
          <div className={classes.envelopeNote}>{envelope.note}</div>
        )}
        <div className={classes.envelopeAmount}>+{money(envelope.cents, currency)}</div>
        {failed ? (
          <div className={classes.envelopeHint}>This envelope was already opened.</div>
        ) : (
          <div className={classes.envelopeHint}>Hold a jar to pour it in!</div>
        )}
        <button
          type="button"
          className={classes.actionButton}
          style={{ width: '100%', marginTop: 10 }}
          onClick={onToJars}
        >
          🍯 Go to my jars
        </button>
        <button
          type="button"
          className={classes.closeLink}
          style={{ color: '#7b6646' }}
          onClick={onClose}
        >
          Later
        </button>
      </motion.div>
    </motion.div>
  );
}
