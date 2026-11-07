import { useEffect, useState } from 'react';

/**
 * [APP-SPEED C] Whether a screen given the `navigation` prop is the one shown (its focus and blur events). A screen
 * without them (a test, an older caller) counts as shown.
 */
export function useNavigationFocused(navigation: { isFocused?: () => boolean; addListener?: (event: 'focus' | 'blur', cb: () => void) => (() => void) | undefined } | null | undefined): boolean {
  const [focused, setFocused] = useState(() => navigation?.isFocused?.() ?? true);
  useEffect(() => {
    if (!navigation?.addListener) return;
    setFocused(navigation.isFocused?.() ?? true);
    const offFocus = navigation.addListener('focus', () => setFocused(true));
    const offBlur = navigation.addListener('blur', () => setFocused(false));
    return () => { offFocus?.(); offBlur?.(); };
  }, [navigation]);
  return focused;
}
