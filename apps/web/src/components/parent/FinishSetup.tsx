/**
 * "Install the app" (spec 009, ADR 0028): full screen, straight after pairing or moving
 * the phone to the secure address. One job, no skip. Android opens Chrome's install box
 * from our button (or points at the ⋮ menu when Chrome hasn't offered one); iPhone and
 * iPad list Safari's own taps and ask "Did it install?" when the tab comes back. When it
 * shows is `finishSetupShows` in `@pmp/shared`.
 */
import { finishSetupShows, installRouteOf, type InstallRoute } from '@pmp/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { celebrate } from '../../lib/confetti';
import {
  finishSetupPending,
  finishSetupState,
  forgetFinishSetup,
  installedHere,
  isInstalled,
  isStandalone,
  useInstallPrompt,
} from '../../lib/pwa';
import { sound } from '../../lib/sounds';
import { ArcadeButton } from '../arcade';
import classes from './parent.module.css';

/** Chrome said yes but `appinstalled` never came: call it installed after this long. */
const ACCEPTED_FALLBACK_MS = 10_000;

/** The line under the title. iPhone has none: its steps speak for themselves. */
const LINES: Record<InstallRoute, string | null> = {
  prompt: 'Tap Install. It only takes a moment.',
  menu: 'Install it from your browser’s menu:',
  'ios-more': null,
  'ios-share-bottom': null,
  'ios-share': null,
};

/** Each step: what to tap (as the browser labels it), and where it is, if that helps. */
const STEPS: Record<Exclude<InstallRoute, 'prompt'>, { tap: string; where?: string }[]> = {
  menu: [{ tap: '⋮', where: 'top right' }, { tap: '📲 Install app' }],
  'ios-more': [
    { tap: '⋯', where: 'below' },
    { tap: '⬆︎ Share' },
    { tap: '⊞ Add to Home Screen' },
    { tap: 'Add' },
  ],
  'ios-share-bottom': [
    { tap: '⬆︎ Share', where: 'below' },
    { tap: '⊞ Add to Home Screen' },
    { tap: 'Add' },
  ],
  'ios-share': [{ tap: '⬆︎ Share' }, { tap: '⊞ Add to Home Screen' }, { tap: 'Add' }],
};

/** Where the browser's own button is, for the bouncing hand. */
const POINTER: Partial<Record<InstallRoute, 'top-right' | 'bottom-right' | 'bottom-centre'>> = {
  menu: 'top-right',
  'ios-more': 'bottom-right',
  'ios-share-bottom': 'bottom-centre',
};

export function FinishSetup() {
  const [shown] = useState(() => finishSetupShows(finishSetupState()));
  useEffect(() => {
    // Opened as the installed app, or installed already: nothing left to finish.
    if (!shown && finishSetupPending() && (isStandalone() || isInstalled())) forgetFinishSetup();
  }, [shown]);
  return shown ? <FinishSetupScreen /> : null;
}

type Stage = 'install' | 'installing' | 'ask' | 'done';

function FinishSetupScreen() {
  const install = useInstallPrompt(); // also re-renders on `appinstalled`
  const route = installRouteOf(navigator.userAgent, navigator.maxTouchPoints, install !== null);
  const ios = route.startsWith('ios');
  const me = useQuery({ queryKey: ['device-me'], queryFn: api.deviceMe });
  const [stage, setStage] = useState<Stage>('install');
  const [wobble, setWobble] = useState(0);
  // Chrome's `appinstalled` (from our button or its ⋮ menu) marks this phone installed,
  // and so does the parent's "Yes" on iPhone.
  const done = stage === 'done' || isInstalled();
  const finish = () => {
    installedHere()[1]();
    setStage('done');
  };

  const celebrated = useRef(false);
  useEffect(() => {
    if (!done || celebrated.current) return;
    celebrated.current = true;
    forgetFinishSetup();
    sound.fanfare();
    celebrate({ count: 160, y: 0.4 });
  }, [done]);

  useEffect(() => {
    if (stage !== 'installing') return;
    const timer = setTimeout(finish, ACCEPTED_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  // iOS jumps to the home screen after "Add", hiding this tab. Coming back means: ask.
  const wasHidden = useRef(false);
  useEffect(() => {
    if (!ios || stage !== 'install') return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') wasHidden.current = true;
      else if (wasHidden.current) {
        wasHidden.current = false;
        setStage('ask');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [ios, stage]);

  if (done) {
    return (
      <div
        className={classes.finish}
        data-centred
        role="dialog"
        aria-modal="true"
        aria-labelledby="finish-title"
      >
        <div className={classes.finishRing}>✓</div>
        <h1 id="finish-title" className={classes.finishDone}>
          INSTALLED!
        </h1>
        <p>
          Open Pocket Money Pal from your apps.
          <br />
          You can close this tab.
        </p>
      </div>
    );
  }

  if (stage === 'ask') {
    return (
      <div
        className={classes.finish}
        role="dialog"
        aria-modal="true"
        aria-labelledby="finish-title"
      >
        <div className={classes.finishPaired}>WELCOME BACK</div>
        <img className={classes.finishIcon} src="/parent/icon-192.png" alt="" />
        <h1 id="finish-title">Did it install?</h1>
        <div className={classes.finishGrow} />
        <ArcadeButton
          tone="green"
          className={classes.finishButton}
          onClick={() => {
            finish();
          }}
        >
          ✓ Yes, it’s installed
        </ArcadeButton>
        <ArcadeButton
          tone="ghost"
          size="small"
          onClick={() => {
            sound.tap();
            setStage('install');
          }}
        >
          No, show me again
        </ArcadeButton>
      </div>
    );
  }

  const name = me.data?.parent.name;
  const pointer = stage === 'install' ? POINTER[route] : undefined;
  return (
    <div
      className={classes.finish}
      data-ios={ios || undefined}
      data-pointer={pointer}
      role="dialog"
      aria-modal="true"
      aria-labelledby="finish-title"
    >
      <div className={classes.finishPaired}>✓ PAIRED{name ? ` AS ${name.toUpperCase()}` : ''}</div>
      <img className={classes.finishIcon} src="/parent/icon-192.png" alt="" />
      <h1 id="finish-title">Install the app</h1>
      {stage === 'installing' ? <p>Installing…</p> : LINES[route] && <p>{LINES[route]}</p>}
      <div className={classes.finishGrow} />
      {stage === 'installing' ? (
        <div className={classes.finishBar}>
          <i />
        </div>
      ) : route === 'prompt' && install ? (
        <ArcadeButton
          key={wobble}
          className={classes.finishButton}
          data-pulse
          data-wobble={wobble > 0 || undefined}
          onClick={() => {
            sound.tap();
            void install().then((ok) => {
              if (ok) setStage('installing');
              else {
                sound.sad();
                setWobble((n) => n + 1);
              }
            });
          }}
        >
          📲 Install
        </ArcadeButton>
      ) : (
        <ol className={classes.finishSteps}>
          {STEPS[route === 'prompt' ? 'menu' : route].map((s) => (
            <li key={s.tap}>
              <span>Tap</span>
              <b>{s.tap}</b>
              {s.where && <small>{s.where}</small>}
            </li>
          ))}
        </ol>
      )}
      {pointer && (
        <span className={classes.finishPointer} aria-hidden>
          {pointer === 'top-right' ? '👆' : '👇'}
        </span>
      )}
    </div>
  );
}
