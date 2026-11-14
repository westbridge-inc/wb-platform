import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [MENU-SEARCH] The Menu tab's search box answers each key at once; the list follows a moment after the last key, so a
// 328-item menu is not filtered again for every letter. Clearing the box shows the whole menu at once.
// The hook is called as a function: a small stand-in for React keeps its state and runs its effect when its inputs move.

const r = vi.hoisted(() => ({
  state: [] as unknown[],
  at: 0,
  deps: undefined as unknown[] | undefined,
  cleanup: undefined as undefined | (() => void),
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = r.at++;
    if (!(slot in r.state)) r.state[slot] = initial;
    return [r.state[slot], (next: unknown) => { r.state[slot] = next; }];
  },
  useEffect: (fn: () => undefined | (() => void), deps: unknown[]) => {
    if (r.deps && deps.every((d, i) => Object.is(d, r.deps![i]))) return;
    r.deps = deps;
    r.cleanup?.();
    r.cleanup = fn() ?? undefined;
  },
}));

// Imported under a plain name: the hook is called as a function here (one call = one render of the stand-in above).
import { SEARCH_DEBOUNCE_MS, useDebouncedValue as debouncedValueOf } from './useDebouncedValue';

const run = (value: string) => { r.at = 0; return debouncedValueOf(value, SEARCH_DEBOUNCE_MS); };

beforeEach(() => {
  vi.useFakeTimers();
  r.state = []; r.at = 0; r.deps = undefined; r.cleanup = undefined;
});
afterEach(() => { vi.useRealTimers(); });

describe('useDebouncedValue', () => {
  it('waits a moment after the last key before the list follows', () => {
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(300);
    expect(run('')).toBe('');
    expect(run('c')).toBe('');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(run('ch')).toBe('');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(run('ch'), 'the timer restarted at the second key').toBe('');
    vi.advanceTimersByTime(1);
    expect(run('ch')).toBe('ch');
  });

  it('an emptied box applies at once (the whole menu is back without waiting)', () => {
    run('chicken');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(run('chicken')).toBe('chicken');
    expect(run('')).toBe('');
  });
});
