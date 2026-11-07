import { useCallback, useEffect, useState } from 'react';

/** setTimeout's longest wait (about 24.8 days); a later deadline is waited for in steps. */
const MAX_WAIT_MS = 2 ** 31 - 1;

/** The next deadline still ahead of `now` (a deadline at `now` itself counts: its flip is one millisecond away). */
export function nextDeadline(deadlines: readonly (number | null | undefined)[], now: number): number | null {
  let next: number | null = null;
  for (const at of deadlines) {
    if (typeof at !== 'number' || !Number.isFinite(at) || at < now) continue;
    if (next === null || at < next) next = at;
  }
  return next;
}

/**
 * [APP-SPEED C · report item 8] The time, for a screen whose words change only at moments it knows in advance.
 *
 * A live screen used to redraw itself whole every few seconds (DeliveryScreen: every 3 s, even unfocused or on a
 * finished order) only so that a few time-based facts — the hold window closing, the rider's fix going stale, the
 * promised window passing — would flip on time. Here the clock moves exactly at those moments: one timer to the
 * nearest deadline (+1 ms, so `now > deadline` holds when it fires), nothing between them, and nothing at all while
 * `live` is false (the screen hidden, Swift in the background). When the screen is shown again the clock is read at
 * once, so every fact is right the moment it is seen. `bump()` reads the clock now (a countdown that just ran out).
 */
export function useDeadlineClock(deadlines: readonly (number | null | undefined)[], live: boolean): [number, () => void] {
  const [now, setNow] = useState(() => Date.now());
  const bump = useCallback(() => setNow(Date.now()), []);
  // Shown again (focus, foreground): the facts are read against the real time at once.
  useEffect(() => {
    if (live) setNow(Date.now());
  }, [live]);
  const key = deadlines.map((at) => (typeof at === 'number' && Number.isFinite(at) ? String(at) : '')).join('|');
  useEffect(() => {
    if (!live) return;
    const next = nextDeadline(deadlines, now);
    if (next === null) return;
    const wait = Math.min(MAX_WAIT_MS, Math.max(0, next + 1 - Date.now()));
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
    // `key` stands for the deadlines' values (a new array each draw must not restart the timer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, key, now]);
  return [now, bump];
}
