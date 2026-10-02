import {
  formatPairingCode,
  normalisePairingCode,
  type DeviceMe,
  type PairCheckResult,
} from '@pmp/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../../lib/api';
import { celebrate } from '../../lib/confetti';
import { sound } from '../../lib/sounds';
import { ArcadeButton } from '../arcade';
import classes from './parent.module.css';

function codeProblem(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'That code doesn’t exist. Check it and try again.';
    if (err.status === 410) return 'That code has expired or was already used. Ask for a new one.';
    if (err.status === 403) return 'This is the family PC. Pair a phone instead.';
    if (err.status === 400) return 'A code has 8 letters and numbers, like K7QM-4PXD.';
  }
  return 'Can’t reach the family PC. Check you’re on the home Wi-Fi.';
}

/**
 * "Pair this phone" (ADR 0008): for a phone that isn't paired, or was revoked. A code
 * comes from the QR (`/parent/pair?code=…`) or is typed; then the phone picks which
 * grown-up it's for.
 */
export function PairScreen({ onPaired }: { onPaired?: (me: DeviceMe) => void }) {
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState(() => params.get('code') ?? '');
  const [checked, setChecked] = useState<{ code: string; result: PairCheckResult } | null>(null);

  const check = useMutation({
    mutationFn: (code: string) => api.checkPairingCode(code),
    onSuccess: (result, code) => {
      setChecked({ code, result });
      sound.pop();
    },
    onError: () => sound.sad(),
  });

  const pair = useMutation({
    mutationFn: ({ code, parentId }: { code: string; parentId: number }) =>
      api.pair(code, parentId),
    onSuccess: (me) => {
      sound.fanfare();
      celebrate({ count: 140, y: 0.5 });
      onPaired?.(me);
      // /parent/pair then redirects to /parent by itself, saying who it paired as.
      queryClient.setQueryData(['device-me'], me);
      void queryClient.invalidateQueries();
    },
    onError: () => sound.sad(),
  });

  // A code from the QR is checked straight away.
  const fromQr = params.get('code');
  useEffect(() => {
    const code = fromQr ? normalisePairingCode(fromQr) : null;
    if (code) check.mutate(code);
    // Once, for the code the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromQr]);

  const code = normalisePairingCode(typed);

  if (checked) {
    return (
      <div className={classes.pairScreen}>
        <div className={classes.logo}>📱</div>
        <h1>WHO’S THIS PHONE FOR?</h1>
        <p>It will check chores as this grown-up.</p>
        <div className={classes.who2}>
          {checked.result.parents.map((p) => (
            <ArcadeButton
              key={p.id}
              disabled={pair.isPending}
              onClick={() => pair.mutate({ code: checked.code, parentId: p.id })}
            >
              🧙 {p.name}
            </ArcadeButton>
          ))}
        </div>
        {pair.error && <p className={classes.error}>{codeProblem(pair.error)}</p>}
        <ArcadeButton tone="ghost" size="small" onClick={() => setChecked(null)}>
          ‹ Use a different code
        </ArcadeButton>
      </div>
    );
  }

  return (
    <div className={classes.pairScreen}>
      <div className={classes.logo}>🐷</div>
      <h1>PAIR THIS PHONE</h1>
      <p>
        Ask a grown-up whose phone is already paired to open <b>🎮 Players → Pair another phone</b>,
        then scan the code with your camera.
      </p>
      <p>No phone paired yet? The quest board on the family PC shows a code.</p>
      <p>Or type the code here:</p>
      <input
        className={classes.codeInput}
        placeholder="K7QM-4PXD"
        value={typed}
        maxLength={12}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        aria-label="Pairing code"
        onChange={(e) => setTyped(e.target.value)}
        onBlur={() => code && setTyped(formatPairingCode(code))}
      />
      {check.error && <p className={classes.error}>{codeProblem(check.error)}</p>}
      <ArcadeButton disabled={!code || check.isPending} onClick={() => code && check.mutate(code)}>
        ▶ Next
      </ArcadeButton>
    </div>
  );
}
