import { useLayoutEffect, useRef } from 'react';

/**
 * A ref that always holds the latest `value`, for timers and handlers that run later
 * (a hold that pours coins, an idle timeout). Read it only outside render.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
