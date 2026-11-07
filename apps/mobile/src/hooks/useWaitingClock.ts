import { useEffect, useState } from 'react';
import { liveWaiting, waitingView, type WaitingView } from '../lib/taxiWaiting';

/**
 * [TAXI waiting charge · CONTRACT Rev 2 §8.3] The live wait on a ride, ticking
 * once a second while a wait runs (the contract: "between those [refetches],
 * the apps tick the clock locally from nextChargeAt"). Null when the server
 * sends no `waiting` object — before the driver arrives, or a server without
 * the waiting charge — so the screens draw nothing new.
 *
 * [APP-SPEED C · report item 8] `shown`: the clock ticks only while its screen is the one shown (false: no timer;
 * shown again, it reads the time at once). Call it from the small card that draws the wait, so a tick redraws that
 * card only, not the whole trip screen and its map.
 */
export function useWaitingClock(ride: unknown, shown = true): WaitingView | null {
  const live = liveWaiting(ride);
  const running = live?.running === true;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !shown) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, shown]);
  return live ? waitingView(live, running ? now : Date.now()) : null;
}
