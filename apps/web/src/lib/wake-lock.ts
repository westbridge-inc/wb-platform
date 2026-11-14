import { useEffect } from 'react';

// ---------------------------------------------------------------------------
// [STORE-BOARD · parity audit C4, owner 14 Nov 2026] A counter tablet running the website must not go dark while
// the order board is open. The browser's Screen Wake Lock: asked for while the board is on screen, asked for again
// when the tab comes back (a browser drops the lock whenever the tab is hidden), released when the board closes. A
// browser without it, or one that refuses (battery saver, no permission), keeps its normal sleep: nothing breaks.
// ---------------------------------------------------------------------------

type Sentinel = { release: () => Promise<void>; released?: boolean };
type WakeLockApi = { request: (_type: 'screen') => Promise<Sentinel> };

/** The browser's wake lock, or null where it has none. */
export function screenWakeLock(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): WakeLockApi | null {
  const wl = (nav as { wakeLock?: WakeLockApi } | undefined)?.wakeLock;
  return wl && typeof wl.request === 'function' ? wl : null;
}

/** Keep the screen awake while `on` and this page is shown. */
export function useScreenWakeLock(on: boolean): void {
  useEffect(() => {
    const api = screenWakeLock();
    if (!on || !api || typeof document === 'undefined') return;
    let live = true;
    let held: Sentinel | null = null;
    let asking = false;
    const ask = () => {
      if (!live || asking || document.visibilityState !== 'visible' || (held && !held.released)) return;
      asking = true;
      api.request('screen').then(
        (sentinel) => { asking = false; if (live) held = sentinel; else void sentinel.release().catch(() => {}); },
        () => { asking = false; /* refused: the screen keeps its normal sleep */ },
      );
    };
    ask();
    document.addEventListener('visibilitychange', ask);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', ask);
      if (held && !held.released) void held.release().catch(() => {});
      held = null;
    };
  }, [on]);
}
