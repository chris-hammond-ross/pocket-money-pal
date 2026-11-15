/**
 * "Install the app" (spec 009, ADR 0028): full screen, straight after pairing or moving
 * the phone to the secure address. One job, no skip. Android opens Chrome's install box
 * from our button (or points at the ⋮ menu when Chrome hasn't offered one); iPhone and
 * iPad list Safari's own taps and ask "Did it install?" when the tab comes back. A browser
 * that can't install (DuckDuckGo, an app's built-in browser) is sent to Chrome or Safari
 * with a one-time move code, so the pairing goes with it; only there can the parent keep
 * using the tab instead. When it shows is `finishSetupShows` in `@pmp/shared`, and how it
 * installs is `installRouteOf`.
 */
import {
  CANT_INSTALL,
  chromeIntentUrl,
  finishSetupShows,
  installRouteOf,
  type InstallRoute,
} from '@pmp/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { celebrate } from '../../lib/confetti';
import {
  finishSetupPending,
  finishSetupState,
  forgetFinishSetup,
  installedHere,
  installHints,
  isInstalled,
  isStandalone,
  useInstallPrompt,
} from '../../lib/pwa';
import { pairUrl } from '../../lib/qr';
import { sound } from '../../lib/sounds';
import { ArcadeButton } from '../arcade';
import classes from './parent.module.css';

/** Chrome said yes but `appinstalled` never came: call it installed after this long. */
const ACCEPTED_FALLBACK_MS = 10_000;
/** A move code lasts 10 minutes: fetch a fresh one before it runs out. */
const MOVE_CODE_REFRESH_MS = 9 * 60_000;

/** The line under the title. iPhone has none: its steps speak for themselves. */
const LINES: Record<InstallRoute, string | null> = {
  prompt: 'Tap Install. It only takes a moment.',
  menu: 'Install it from your browser’s menu:',
  'firefox-menu': 'Install it from Firefox’s menu:',
  'opera-menu': 'Install it from Opera’s menu:',
  'ios-more': null,
  'ios-share-bottom': null,
  'ios-share': null,
  'open-in-chrome': 'This browser can’t install apps. Chrome can, and the phone stays paired.',
  'open-in-safari':
    'This app’s browser can’t install apps. Copy the link, then paste it into Safari.',
};

/** Each step: what to tap (as the browser labels it), and where it is, if that helps. */
type StepRoute = Exclude<InstallRoute, 'prompt' | 'open-in-chrome' | 'open-in-safari'>;
const STEPS: Record<StepRoute, { tap: string; where?: string }[]> = {
  menu: [{ tap: '⋮', where: 'top right' }, { tap: '📲 Install app' }],
  // Firefox's and Opera's menus aren't checked on a real phone: "Install with Chrome
  // instead" is there in case they say something else.
  'firefox-menu': [{ tap: '⋮', where: 'by the address' }, { tap: '📲 Add app to Home screen' }],
  'opera-menu': [{ tap: '⋮', where: 'menu' }, { tap: 'Add to…' }, { tap: 'Home screen' }],
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
  const [shown, setShown] = useState(() => finishSetupShows(finishSetupState()));
  useEffect(() => {
    // Opened as the installed app, or installed already: nothing left to finish.
    if (!shown && finishSetupPending() && (isStandalone() || isInstalled())) forgetFinishSetup();
  }, [shown]);
  return shown ? <FinishSetupScreen onKeepTab={() => setShown(false)} /> : null;
}

type Stage = 'install' | 'installing' | 'ask' | 'done';

function FinishSetupScreen({ onKeepTab }: { onKeepTab: () => void }) {
  const install = useInstallPrompt(); // also re-renders on `appinstalled`
  // Firefox or Opera, whose menu steps didn't work out: carry on in Chrome.
  const [useChrome, setUseChrome] = useState(false);
  const route: InstallRoute = useChrome
    ? 'open-in-chrome'
    : installRouteOf(installHints(install !== null));
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
  if (CANT_INSTALL.includes(route)) {
    return (
      <OpenElsewhere
        browser={route === 'open-in-safari' ? 'Safari' : 'Chrome'}
        paired={name}
        line={
          useChrome ? 'Chrome installs it in one tap, and the phone stays paired.' : LINES[route]
        }
        onKeepTab={() => {
          sound.tap();
          forgetFinishSetup();
          onKeepTab();
        }}
      />
    );
  }

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
          {STEPS[route === 'prompt' ? 'menu' : (route as StepRoute)].map((s) => (
            <li key={s.tap}>
              <span>Tap</span>
              <b>{s.tap}</b>
              {s.where && <small>{s.where}</small>}
            </li>
          ))}
        </ol>
      )}
      {(route === 'firefox-menu' || route === 'opera-menu') && (
        <ArcadeButton
          tone="ghost"
          size="small"
          className={classes.finishOther}
          onClick={() => {
            sound.tap();
            setUseChrome(true);
          }}
        >
          Install with Chrome instead
        </ArcadeButton>
      )}
      {pointer && (
        <span className={classes.finishPointer} aria-hidden>
          {pointer === 'top-right' ? '👆' : '👇'}
        </span>
      )}
    </div>
  );
}

/**
 * "Open this in Chrome to install" (or Safari, from an app's browser on iOS). The link
 * carries a one-time move code (ADR 0009), fetched ahead so the tap opens Chrome at once:
 * pairing there unpairs this browser. The rest of the app is behind this screen, so nothing
 * can be waiting in the offline queue here.
 */
function OpenElsewhere({
  browser,
  paired,
  line,
  onKeepTab,
}: {
  browser: 'Chrome' | 'Safari';
  paired: string | undefined;
  line: string | null;
  onKeepTab: () => void;
}) {
  const move = useQuery({
    queryKey: ['move-code'],
    queryFn: () => api.invite(true),
    staleTime: MOVE_CODE_REFRESH_MS,
    refetchInterval: MOVE_CODE_REFRESH_MS,
  });
  const link = move.data ? pairUrl(location.origin, move.data.code, true) : null;
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    if (!link) return;
    sound.tap();
    navigator.clipboard.writeText(link).then(
      () => {
        sound.pop();
        setCopied('yes');
      },
      () => setCopied('failed'),
    );
  };
  const chrome = browser === 'Chrome';
  return (
    <div className={classes.finish} role="dialog" aria-modal="true" aria-labelledby="finish-title">
      <div className={classes.finishPaired}>
        ✓ PAIRED{paired ? ` AS ${paired.toUpperCase()}` : ''}
      </div>
      <img className={classes.finishIcon} src="/parent/icon-192.png" alt="" />
      <h1 id="finish-title">Open this in {browser} to install</h1>
      {line && <p>{line}</p>}
      <div className={classes.finishGrow} />
      {move.isError ? (
        <p className={classes.finishNote}>
          Can’t reach the family PC. Check it’s on, then{' '}
          <button type="button" onClick={() => void move.refetch()}>
            try again
          </button>
          .
        </p>
      ) : (
        copied && (
          <p className={classes.finishNote} role="status">
            {copied === 'yes' ? (
              `Copied! Paste it into ${browser}’s address bar. It works for 10 minutes.`
            ) : (
              <>
                Copy this into {browser}’s address bar:
                <br />
                <code>{link}</code>
              </>
            )}
          </p>
        )
      )}
      {chrome && (
        <ArcadeButton
          tone="green"
          className={classes.finishButton}
          data-pulse
          disabled={!link}
          onClick={() => {
            if (!link) return;
            sound.tap();
            location.href = chromeIntentUrl(link);
          }}
        >
          🌐 Open in Chrome
        </ArcadeButton>
      )}
      <ArcadeButton
        tone={chrome ? 'ghost' : 'green'}
        size={chrome ? 'small' : undefined}
        className={chrome ? classes.finishOther : classes.finishButton}
        data-pulse={!chrome || undefined}
        disabled={!link}
        onClick={copy}
      >
        📋 Copy the link
      </ArcadeButton>
      <button type="button" className={classes.finishKeep} onClick={onKeepTab}>
        Keep using this tab
      </button>
    </div>
  );
}
