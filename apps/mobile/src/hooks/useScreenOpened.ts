import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// [APP-SPEED D · owner 7 Nov: "you tap Taxi — it LOADS, then goes to it"]
// A screen slides in only once its first frame is built, and a map is the
// heaviest thing a first frame can hold (the native map view is created as the
// screen mounts, on the same thread that runs the slide). Taxi and Send drew
// their map in that first frame, so the tap sat still, then the screen jumped
// in. They now draw the map's ground first and the map itself as soon as the
// slide has finished.
//
// Only what is DRAWN waits: every read, every hold on Request/Send and SOS are
// unchanged, and nothing that can be pressed lives on the map.
// ---------------------------------------------------------------------------

/** If the slide never reports its end (no animation, a reduced-motion setting), the map is drawn after this. */
export const OPENED_FALLBACK_MS = 450;

interface TransitionSource {
  addListener?: (event: 'transitionEnd', callback: () => void) => (() => void) | undefined;
}

/**
 * False on the first frame of a screen that slides in, true once the slide has ended (native-stack's
 * `transitionEnd`) or after OPENED_FALLBACK_MS. True at once when there is no navigator to slide it in (nothing to
 * wait for).
 */
export function useScreenOpened(navigation: TransitionSource | null | undefined): boolean {
  const canListen = typeof navigation?.addListener === 'function';
  const [opened, setOpened] = useState(!canListen);
  useEffect(() => {
    if (opened || !canListen) return undefined;
    let live = true;
    const open = () => { if (live) { live = false; setOpened(true); } };
    const off = navigation!.addListener!('transitionEnd', open);
    const timer = setTimeout(open, OPENED_FALLBACK_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      if (typeof off === 'function') off();
    };
  }, [opened, canListen, navigation]);
  return opened;
}
