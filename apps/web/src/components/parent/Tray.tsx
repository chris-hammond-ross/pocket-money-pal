import type { TrayItem } from '@pmp/shared';
import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { confettiFrom } from '../../lib/confetti';
import { clockTimeAt } from '../../lib/format';
import { sound } from '../../lib/sounds';
import { arcade } from '../../theme';
import { ArcadeButton } from '../arcade';
import { useChoreActions } from './actions';
import { useDay, useParentUi } from './context';
import classes from './parent.module.css';
import { SendBackSheet } from './SendBackSheet';

/** Past this, a released card approves (right) or sends back (left). Spec 003. */
const SWIPE_PX = 90;
/** A quick flick counts from here, if it's moving at least FLICK_PX_PER_MS. */
const FLICK_MIN_PX = 40;
const FLICK_PX_PER_MS = 0.6;
/** Movement before we decide between a swipe and a scroll. */
const SLOP_PX = 8;

interface Child {
  id: number;
  name: string;
  avatar: string;
  colour: string;
}

/**
 * The to-check tray (spec 003): pinned to the bottom while anything is claimed. Swipe a
 * card right to approve, left to send back, or tap it to open the quest.
 */
export function Tray({
  items,
  open,
  onToggle,
}: {
  items: TrayItem[];
  open: boolean;
  onToggle: () => void;
}) {
  const ui = useParentUi();
  const today = useDay('today');
  const actions = useChoreActions();
  // Cards on their way out: hidden until the refetch drops them (or an error brings them back).
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const [sendingBack, setSendingBack] = useState<{ item: TrayItem; reset: () => void } | null>(
    null,
  );

  const children = new Map((today.data?.children ?? []).map((c) => [c.id, c]));
  const shown = items.filter((i) => !leaving.has(i.instanceId));
  const total = shown.reduce((sum, i) => sum + i.points.total, 0);
  if (items.length === 0) return null;

  const leave = (id: number) => setLeaving((s) => new Set(s).add(id));
  const stay = (id: number) =>
    setLeaving((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });

  const approveOne = (item: TrayItem) => {
    leave(item.instanceId);
    actions.approve.mutate([item.instanceId], { onError: () => stay(item.instanceId) });
  };

  const approveAll = () => {
    const ids = shown.map((i) => i.instanceId);
    ids.forEach(leave);
    sound.fanfare();
    confettiFrom(new DOMRect(innerWidth / 2 - 40, innerHeight - 120, 80, 80), [
      arcade.gold,
      arcade.bonus,
      '#ffffff',
    ]);
    actions.approve.mutate(ids, {
      onSuccess: () => {
        ui.notify({
          icon: '🎉',
          title: `+${total} points approved`,
          body: 'Watch them land on the board!',
        });
        onToggle();
      },
      onError: () => ids.forEach(stay),
    });
  };

  // A removed player's claim stays in the tray (ADR 0009), with the look it came with.
  const sendChild = sendingBack
    ? (children.get(sendingBack.item.childId) ?? {
        id: sendingBack.item.childId,
        ...sendingBack.item.child,
      })
    : undefined;

  return (
    <section className={classes.tray} data-open={open || undefined} aria-label="To check">
      <button type="button" className={classes.trayHandle} onClick={onToggle}>
        <span key={shown.length} className={classes.count}>
          {shown.length}
        </span>
        <b>to check</b>
        <span className={classes.total}>+{total} ⭐</span>
        <span aria-hidden>{open ? '▼' : '▲'}</span>
      </button>
      {open && (
        <>
          <div className={classes.trayList}>
            {items.map((item) => (
              <SwipeCard
                key={item.instanceId}
                item={item}
                child={children.get(item.childId) ?? { id: item.childId, ...item.child }}
                timezone={today.data?.timezone}
                gone={leaving.has(item.instanceId)}
                onApprove={() => approveOne(item)}
                onSendBack={(reset) => setSendingBack({ item, reset })}
                onTap={() => ui.openQuest(item.choreId)}
              />
            ))}
          </div>
          <div className={classes.trayFoot}>
            <div className={classes.hint}>
              👉 swipe right to approve · swipe left to send back 👈
            </div>
            <ArcadeButton
              tone="green"
              disabled={shown.length === 0 || actions.approve.isPending}
              onClick={approveAll}
            >
              ✓ Approve all {shown.length} (+{total})
            </ArcadeButton>
          </div>
        </>
      )}
      <SendBackSheet
        target={
          sendingBack && {
            childName: sendChild?.name ?? '',
            avatar: sendChild?.avatar ?? '',
            title: sendingBack.item.title,
          }
        }
        onKeep={() => {
          sendingBack?.reset();
          setSendingBack(null);
        }}
        onPick={(reason) => {
          if (!sendingBack) return;
          const id = sendingBack.item.instanceId;
          leave(id);
          actions.sendBack.mutate(
            { id, reason },
            {
              onError: () => {
                stay(id);
                sendingBack.reset();
              },
            },
          );
          setSendingBack(null);
        }}
      />
    </section>
  );
}

interface Gesture {
  pointerId: number;
  x0: number;
  y0: number;
  t0: number;
  dx: number;
  mode: 'pending' | 'swipe' | 'scroll';
  /** For the release velocity. */
  lastX: number;
  lastT: number;
  vx: number;
  armed: 'left' | 'right' | null;
}

/**
 * One tray card. The gesture is plain pointer events with `touch-action: pan-y`, so the
 * list still scrolls vertically: a drag only becomes a swipe once it's clearly sideways.
 * The card follows the finger directly (no React render per move), tilts, and shows
 * what a release would do. Crossing the threshold buzzes once where phones allow it.
 */
function SwipeCard({
  item,
  child,
  timezone,
  gone,
  onApprove,
  onSendBack,
  onTap,
}: {
  item: TrayItem;
  child: Child | undefined;
  timezone: string | undefined;
  gone: boolean;
  onApprove: () => void;
  onSendBack: (reset: () => void) => void;
  onTap: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const g = useRef<Gesture | null>(null);

  const setDir = (dir: 'left' | 'right' | null, armed: 'left' | 'right' | null) => {
    const el = wrap.current;
    if (!el) return;
    if (dir) el.dataset.dir = dir;
    else delete el.dataset.dir;
    el.querySelectorAll<HTMLElement>('[data-side]').forEach((s) => {
      if (s.dataset.side === armed) s.dataset.armed = '';
      else delete s.dataset.armed;
    });
  };

  const place = (dx: number, animate: boolean) => {
    const el = card.current;
    if (!el) return;
    el.style.transition = animate ? 'transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2)' : 'none';
    el.style.transform = dx ? `translateX(${dx}px) rotate(${dx / 40}deg)` : '';
  };

  const reset = () => {
    place(0, true);
    setDir(null, null);
  };

  const flyOut = (to: 'left' | 'right', then: () => void) => {
    const el = card.current;
    if (!el) return;
    el.style.transition = 'transform 0.2s ease-in';
    el.style.transform = `translateX(${to === 'right' ? 120 : -120}%) rotate(${to === 'right' ? 8 : -8}deg)`;
    setTimeout(then, 180);
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || g.current) return;
    g.current = {
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      t0: e.timeStamp,
      dx: 0,
      mode: 'pending',
      lastX: e.clientX,
      lastT: e.timeStamp,
      vx: 0,
      armed: null,
    };
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s || s.pointerId !== e.pointerId || s.mode === 'scroll') return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (s.mode === 'pending') {
      if (Math.abs(dx) > SLOP_PX && Math.abs(dx) > Math.abs(dy)) {
        s.mode = 'swipe';
        e.currentTarget.setPointerCapture(e.pointerId);
      } else if (Math.abs(dy) > SLOP_PX) {
        s.mode = 'scroll';
        return;
      } else return;
    }
    const dt = e.timeStamp - s.lastT;
    if (dt > 0) s.vx = 0.7 * ((e.clientX - s.lastX) / dt) + 0.3 * s.vx;
    s.lastX = e.clientX;
    s.lastT = e.timeStamp;
    s.dx = dx;
    place(dx, false);
    const armed = dx > SWIPE_PX ? 'right' : dx < -SWIPE_PX ? 'left' : null;
    if (armed && armed !== s.armed) navigator.vibrate?.(12);
    s.armed = armed;
    setDir(dx > 0 ? 'right' : dx < 0 ? 'left' : null, armed);
  };

  const up = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s || s.pointerId !== e.pointerId) return;
    g.current = null;
    if (s.mode === 'pending') {
      if (e.timeStamp - s.t0 < 500) onTap();
      return;
    }
    if (s.mode !== 'swipe') return;
    const flickRight = s.vx > FLICK_PX_PER_MS && s.dx > FLICK_MIN_PX;
    const flickLeft = s.vx < -FLICK_PX_PER_MS && s.dx < -FLICK_MIN_PX;
    if (s.dx > SWIPE_PX || flickRight) {
      sound.coin();
      const rect = card.current?.getBoundingClientRect();
      if (rect) confettiFrom(rect, [child?.colour ?? arcade.gold, arcade.gold, '#ffffff'], 30);
      flyOut('right', onApprove);
    } else if (s.dx < -SWIPE_PX || flickLeft) {
      flyOut('left', () => onSendBack(reset));
    } else {
      reset();
    }
  };

  const cancel = () => {
    if (g.current?.mode === 'swipe') reset();
    g.current = null;
  };

  return (
    <div
      ref={wrap}
      className={classes.swipe}
      data-gone={gone || undefined}
      data-instance-id={item.instanceId}
    >
      <div className={classes.under} aria-hidden>
        <span data-side="right">✓ APPROVE</span>
        <span data-side="left">SEND BACK ↩</span>
      </div>
      <div
        ref={card}
        className={classes.card}
        style={{ '--c': child?.colour ?? arcade.gold } as CSSProperties}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className={classes.avatar}>{child?.avatar ?? '🙂'}</div>
        <div className={classes.grow}>
          <b>
            {item.icon} {item.title}
          </b>
          <small>
            {child?.name} · {timezone ? clockTimeAt(item.claimedAt, timezone) : ''} ·{' '}
            {item.unprompted ? '🦸 unprompted' : '🙋 reminded'}
          </small>
        </div>
        <span className={classes.cardPoints}>+{item.points.total}</span>
      </div>
    </div>
  );
}
