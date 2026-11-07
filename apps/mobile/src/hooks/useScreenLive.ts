import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';

/** [APP-SPEED 11] Whether the phone is in front of the person: Swift in the foreground ('active', or not known yet at
 *  start). In the background, or 'inactive' (a call, the notification shade), nothing on screen is being watched. */
export function appStateLive(state: string | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

/**
 * [APP-SPEED 11] True while this screen is the one shown AND Swift is in the foreground. Timers, measuring loops and
 * videos on a screen run only while it is live: a screen under another one (Home stays mounted, not frozen, behind
 * every other tab and screen), or a phone in a pocket, does no work for nobody.
 */
export function useScreenLive(): boolean {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(() => appStateLive(AppState.currentState));
  useEffect(() => {
    setForeground(appStateLive(AppState.currentState));
    const subscription = AppState.addEventListener('change', (state) => setForeground(appStateLive(state)));
    return () => subscription.remove();
  }, []);
  return focused && foreground;
}
