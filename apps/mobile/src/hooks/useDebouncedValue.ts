import { useEffect, useState } from 'react';

/** [MENU-SEARCH] How long after the last key a search box's list follows. */
export const SEARCH_DEBOUNCE_MS = 180;

/**
 * The value, a moment after it last changed: the box shows each key at once, the list it filters follows once the
 * typing pauses. An emptied value applies at once (clearing a search shows everything without waiting).
 */
export function useDebouncedValue(value: string, delayMs: number = SEARCH_DEBOUNCE_MS): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === '') {
      setSettled('');
      return undefined;
    }
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value === '' ? '' : settled;
}
