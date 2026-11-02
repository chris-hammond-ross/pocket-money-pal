/**
 * Setup → REMOTE ACCESS (spec 008, ADR 0025): a licence key connects the family PC to the
 * relay, so phones reach it at `https://<id>.pocketmoneypal.app`, at home and away. Four
 * states: not set up, connected (or connecting), and a problem. Every change arrives as
 * `relay.changed`, which refetches `relay`.
 */
import { RELAY_RECONNECTING_AFTER_MS, type RelayInfo, type TunnelProblem } from '@pmp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { sound } from '../../lib/sounds';
import { ArcadeButton, CloseButton, Sheet } from '../arcade';
import { MOVE_LABEL, MoveButton, useMoveTarget } from './MoveToSecure';
import { problemText, useParentUi } from './context';
import classes from './parent.module.css';

const SITE = 'https://pocketmoneypal.com';

/** What went wrong connecting, in the spec's words. */
function connectProblem(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'unknown-licence':
        return 'That key isn’t right. Check it against your purchase email.';
      case 'licence-expired':
        return 'This licence has expired. Renew it at pocketmoneypal.com.';
      case 'licence-revoked':
        return 'This licence can’t be used. Contact support@pocketmoneypal.com.';
      case 'relay-unreachable':
        return 'Can’t reach Pocket Money Pal’s remote access service. Check the PC’s internet connection and try again.';
      case 'update-needed':
        return 'Update Pocket Money Pal on the family PC first.';
      case 'rate-limited':
        return 'That’s a lot of tries. Wait a minute, then try again.';
    }
    if (err.status === 400) return 'Type the licence key from your purchase email.';
  }
  return problemText(err);
}

/** The Problem state's reason, and what to do. */
const PROBLEM_TEXT: Record<TunnelProblem, string> = {
  'licence-expired': 'This licence has expired. Renew it at pocketmoneypal.com, then try again.',
  'licence-revoked': 'This licence can’t be used. Contact support@pocketmoneypal.com.',
  moved: 'Remote access moved to another PC. Enter the licence key to move it back here.',
  'bad-secret':
    'The remote access service doesn’t recognise this PC any more. Enter the licence key to connect again.',
  'update-needed': 'Update Pocket Money Pal on the family PC first.',
};

/** Problems fixed by entering the key again, and those where "Try again" may do. */
const NEEDS_KEY: TunnelProblem[] = ['moved', 'bad-secret'];
const CAN_RETRY: TunnelProblem[] = ['licence-expired', 'licence-revoked'];

export function RemoteAccess() {
  const relay = useQuery({ queryKey: ['relay'], queryFn: api.relay, retry: false });
  if (!relay.data) return null;
  const info = relay.data;
  if (info.state === 'off') return <NotSetUp />;
  if (info.state === 'problem') return <Problem info={info} />;
  return <Connected info={info} />;
}

/** The licence-key field and Connect, with "in use on another PC?" when it is. */
function LicenceForm({ cta = 'Connect' }: { cta?: string }) {
  const queryClient = useQueryClient();
  const ui = useParentUi();
  const [key, setKey] = useState('');
  const [askMove, setAskMove] = useState(false);
  const connect = useMutation({
    mutationFn: (takeOver: boolean) => api.connectRelay(key, takeOver),
    onSuccess: (info) => {
      setAskMove(false);
      queryClient.setQueryData(['relay'], info);
      void queryClient.invalidateQueries({ queryKey: ['access'] });
      sound.fanfare();
      ui.notify({
        icon: '🌍',
        title: info.state === 'connected' ? 'Remote access is on' : 'Connecting…',
        body: 'Phones can now reach the family PC from anywhere.',
      });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'licence-in-use') {
        setAskMove(true);
        return;
      }
      sound.sad();
    },
  });
  const error = connect.error;
  const showError = error && !(error instanceof ApiError && error.code === 'licence-in-use');

  return (
    <>
      <input
        className={`${classes.codeInput} ${classes.licenceInput}`}
        placeholder="PMP-XXXXX-…"
        value={key}
        maxLength={100}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        aria-label="Licence key"
        onChange={(e) => setKey(e.target.value)}
      />
      {showError && <p className={classes.error}>{connectProblem(error)}</p>}
      <div className={classes.remoteActions}>
        <ArcadeButton
          size="small"
          disabled={!key.trim() || connect.isPending}
          onClick={() => {
            sound.tap();
            connect.mutate(false);
          }}
        >
          {connect.isPending ? '⏳ Connecting…' : cta}
        </ArcadeButton>
      </div>

      {askMove && (
        <Sheet
          opened
          short
          onClose={() => setAskMove(false)}
          head={
            <>
              <span className={classes.sheetTitle}>🔁 Move remote access?</span>
              <CloseButton onClick={() => setAskMove(false)} />
            </>
          }
          footer={
            <div className={classes.remoteActions}>
              <ArcadeButton disabled={connect.isPending} onClick={() => connect.mutate(true)}>
                {connect.isPending ? '⏳ Moving…' : 'Move it'}
              </ArcadeButton>
              <ArcadeButton tone="ghost" size="small" onClick={() => setAskMove(false)}>
                Cancel
              </ArcadeButton>
            </div>
          }
        >
          <p className={classes.note}>
            This licence is in use on another PC. Move remote access to this PC? The other PC’s
            phones will stop working remotely.
          </p>
          {connect.error &&
            !(connect.error instanceof ApiError && connect.error.code === 'licence-in-use') && (
              <p className={classes.error}>{connectProblem(connect.error)}</p>
            )}
        </Sheet>
      )}
    </>
  );
}

function NotSetUp() {
  return (
    <div className={classes.remoteCard}>
      <div className={classes.remoteHead}>🌍 Remote access</div>
      <p>
        Use the app away from home, install it on your phone, and get a buzz when a chore is done.
      </p>
      <LicenceForm />
      <p className={classes.note}>
        Don’t have one?{' '}
        <a href={SITE} target="_blank" rel="noreferrer">
          pocketmoneypal.com
        </a>
      </p>
    </div>
  );
}

/** Re-renders every few seconds, so "Connecting…" turns into "Reconnecting…" on time. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

function Connected({ info }: { info: RelayInfo }) {
  const { needed, isRelay } = useMoveTarget();
  const connecting = info.state === 'connecting';
  const now = useTick(connecting);
  const reconnecting = connecting && now - info.since > RELAY_RECONNECTING_AFTER_MS;
  return (
    <div className={classes.remoteCard}>
      <div className={classes.remoteHead}>
        <span>🌍 Remote access</span>
        <span className={classes.remoteState}>
          {connecting ? (reconnecting ? '🟠 Reconnecting…' : '⏳ Connecting…') : '🟢 Connected'}
        </span>
      </div>
      {reconnecting && <p>Trying to reconnect. Please wait a moment.</p>}
      {!connecting && needed && isRelay && (
        <>
          <p>
            The family PC is connected, but this phone is still on its old address. Switch it over
            to install the app and use it from anywhere.
          </p>
          <MoveButton label={MOVE_LABEL} />
        </>
      )}
      <Disconnect info={info} />
    </div>
  );
}

function Problem({ info }: { info: RelayInfo }) {
  const queryClient = useQueryClient();
  const ui = useParentUi();
  const problem = info.problem ?? 'bad-secret';
  const retry = useMutation({
    mutationFn: api.retryRelay,
    onSuccess: (next) => {
      queryClient.setQueryData(['relay'], next);
      if (next.state === 'connected') sound.fanfare();
      else sound.sad();
    },
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Not connected', body: problemText(err), tone: 'error' }),
  });
  return (
    <div className={classes.remoteCard}>
      <div className={classes.remoteHead}>
        <span>🌍 Remote access</span>
        <span className={classes.remoteState}>🔴 Not working</span>
      </div>
      <p>{PROBLEM_TEXT[problem]}</p>
      {NEEDS_KEY.includes(problem) && <LicenceForm cta="Connect again" />}
      {CAN_RETRY.includes(problem) && (
        <div className={classes.remoteActions}>
          <ArcadeButton
            size="small"
            disabled={retry.isPending}
            onClick={() => {
              sound.tap();
              retry.mutate();
            }}
          >
            {retry.isPending ? '⏳ Trying…' : '🔁 Try again'}
          </ArcadeButton>
        </div>
      )}
      <Disconnect info={info} />
    </div>
  );
}

/** "Disconnect", behind a confirm. A phone on the relay address is warned it'll cut itself off. */
function Disconnect({ info }: { info: RelayInfo }) {
  const queryClient = useQueryClient();
  const ui = useParentUi();
  const [open, setOpen] = useState(false);
  const onRelay = info.url !== null && sameOrigin(info.url);
  const off = useMutation({
    mutationFn: api.disconnectRelay,
    onSuccess: (next) => {
      setOpen(false);
      queryClient.setQueryData(['relay'], next);
      void queryClient.invalidateQueries({ queryKey: ['access'] });
      sound.pop();
      ui.notify({
        icon: '🌍',
        title: 'Remote access is off',
        body: 'Your licence stays yours: connect again whenever you like.',
      });
    },
    onError: (err) =>
      ui.notify({ icon: '⚠️', title: 'Not turned off', body: problemText(err), tone: 'error' }),
  });
  return (
    <>
      <div className={classes.remoteActions}>
        <ArcadeButton
          tone="ghost"
          size="small"
          onClick={() => {
            sound.tap();
            setOpen(true);
          }}
        >
          Disconnect
        </ArcadeButton>
      </div>
      {open && (
        <Sheet
          opened
          short
          onClose={() => setOpen(false)}
          head={
            <>
              <span className={classes.sheetTitle}>🌍 Turn off remote access?</span>
              <CloseButton onClick={() => setOpen(false)} />
            </>
          }
          footer={
            <div className={classes.remoteActions}>
              <ArcadeButton tone="red" disabled={off.isPending} onClick={() => off.mutate()}>
                Turn off
              </ArcadeButton>
              <ArcadeButton tone="ghost" size="small" onClick={() => setOpen(false)}>
                Cancel
              </ArcadeButton>
            </div>
          }
        >
          <p className={classes.note}>
            Phones using the remote address will stop working until you connect again. Your licence
            stays yours.
          </p>
          {onRelay && (
            <p className={classes.error}>
              This phone is using remote access right now. It will lose the app until you open{' '}
              {info.lanUrl ? `${info.lanUrl}/parent` : 'the PC’s home address'} on the home Wi-Fi.
            </p>
          )}
        </Sheet>
      )}
    </>
  );
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
}
