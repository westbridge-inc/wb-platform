import { useCallback, useEffect, useRef } from 'react';

/**
 * [APP-SPEED A · review S2-2] How long a finger must rest on a card before its read starts. A
 * scroll that begins on a card ends the press (onPressOut) well inside this, so flicking through
 * Home or Search downloads no menus; a press that holds starts the read while it is still down.
 */
export const PRESS_READ_DELAY_MS = 100;

/** One press-started read at a time across the app: a second card waits for the first to land. */
let pressReadInFlight = false;

/** The press handlers a card spreads: `{...pressRead(() => read())}`. */
export interface PressReadHandlers {
  onPressIn: () => void;
  onPressOut: () => void;
}

/**
 * Reads asked at the finger-down, held until the finger has rested PRESS_READ_DELAY_MS and
 * cancelled by the press ending first (a lift or a scroll). At most one such read in flight.
 * `read` returns the read's promise, or nothing when there was nothing to ask.
 */
export function usePressRead(): (read: () => Promise<unknown> | void) => PressReadHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => cancel, [cancel]);
  return useCallback((read) => ({
    onPressIn: () => {
      cancel();
      timer.current = setTimeout(() => {
        timer.current = undefined;
        if (pressReadInFlight) return;
        const asked = read();
        if (!asked) return;
        pressReadInFlight = true;
        void asked.catch(() => undefined).finally(() => { pressReadInFlight = false; });
      }, PRESS_READ_DELAY_MS);
    },
    onPressOut: cancel,
  }), [cancel]);
}
