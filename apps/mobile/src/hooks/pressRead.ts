import { useCallback, useEffect, useRef } from 'react';
import { onlineManager } from '@tanstack/react-query';

/**
 * React Native's floor on a press: Pressability holds onPressOut until at least this long after
 * press-in (react-native 0.85.3 Libraries/Pressability/Pressability.js DEFAULT_MIN_PRESS_DURATION,
 * applied in `_deactivate`; Pressable sets no minPressDuration), on a lift AND when a ScrollView
 * takes the touch. A scroll that starts on a card therefore reports its press-out ~130 ms after
 * press-in at the earliest.
 */
export const RN_MIN_PRESS_DURATION_MS = 130;

/**
 * [APP-SPEED A · review S2-2 + delta S2] How long a finger must rest on a card before its read
 * starts. It MUST stay above RN_MIN_PRESS_DURATION_MS: at 100 ms the read started before any
 * press-out could arrive, so every scroll that began on a card still downloaded a menu. At 180 ms
 * the delayed press-out of a lift or a scroll cancels it; a finger that keeps resting reads.
 */
export const PRESS_READ_DELAY_MS = 180;

/** [delta S3-1] The one-at-a-time lock is let go after this even if the read is still on its
 *  way, so a slow or stuck read never blocks every other card's read (retries can take ~1 min). */
export const PRESS_READ_LOCK_MS = 8_000;

/** One press-started read at a time across the app: a second card waits for the first to land
 *  (or for PRESS_READ_LOCK_MS). The token tells a late settle from the read that holds the lock. */
let pressReadLock: object | null = null;

/** The press handlers a card spreads: `{...pressRead(() => read())}`. */
export interface PressReadHandlers {
  onPressIn: () => void;
  onPressOut: () => void;
}

/**
 * Reads asked at the finger-down, held until the finger has rested PRESS_READ_DELAY_MS and
 * cancelled by the press ending first (a lift or a scroll). Nothing is asked offline. At most one
 * such read in flight. `read` returns the read's promise, or nothing when there was nothing to ask.
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
        // Offline the read would only park (and hold the lock); the screen asks for itself.
        if (pressReadLock || !onlineManager.isOnline()) return;
        const asked = read();
        if (!asked) return;
        const token = {};
        pressReadLock = token;
        const release = () => { if (pressReadLock === token) pressReadLock = null; };
        const backstop = setTimeout(release, PRESS_READ_LOCK_MS);
        void asked.catch(() => undefined).finally(() => { clearTimeout(backstop); release(); });
      }, PRESS_READ_DELAY_MS);
    },
    onPressOut: cancel,
  }), [cancel]);
}
