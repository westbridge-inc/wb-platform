import { useEffect } from 'react';
import { closeCallsAskMoment, openCallsAskMoment } from '../services/inAppReach';

/** After the screen has drawn and settled: never a card over a screen still opening. */
export const CALLS_ASK_AFTER_DRAW_MS = 1_500;

/**
 * [CALLS-REACH · review S2-2] The fitting moment to ask an Android phone for the microphone (so the other side's
 * in-app call can ring it): an order-tracking, active-job or store-board screen, `shown` (the one in front, Swift
 * in the foreground) and on a live order. The app-wide layer (components/InAppCallReach) asks only while one is
 * open, and only through the one priming card slot. Opens a beat after the screen has drawn; closes when it is
 * left or covered.
 */
export function useCallsAskMoment(shown: boolean): void {
  useEffect(() => {
    if (!shown) return undefined;
    let token: number | null = null;
    const timer = setTimeout(() => { token = openCallsAskMoment(); }, CALLS_ASK_AFTER_DRAW_MS);
    return () => {
      clearTimeout(timer);
      if (token !== null) closeCallsAskMoment(token);
    };
  }, [shown]);
}
