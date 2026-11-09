import { createOtaCatchUp, type OtaCatchUp } from '../lib/otaCatchUp';

/** The native pieces the catch-up reads, loaded when it is installed (never at import: tests and
 *  screens that import the root navigator load no native module through this file). */
export interface OtaCatchUpNative {
  Updates: Pick<typeof import('expo-updates'), 'isEnabled' | 'latestContext' | 'reloadAsync' | 'checkForUpdateAsync' | 'fetchUpdateAsync' | 'addUpdatesStateChangeListener'>;
  AppState: Pick<typeof import('react-native').AppState, 'addEventListener'>;
  isMutating: () => number;
  inAppCallActive: () => boolean;
  navigation: { isReady(): boolean; getCurrentRoute(): { name: string } | undefined; addListener(event: 'state', cb: () => void): () => void };
}

/* eslint-disable @typescript-eslint/no-require-imports -- loaded on install, not at import (see above) */
const loadNative = (): OtaCatchUpNative => ({
  Updates: require('expo-updates'),
  AppState: require('react-native').AppState,
  isMutating: () => (require('../lib/queryClient') as typeof import('../lib/queryClient')).queryClient.isMutating(),
  inAppCallActive: () => (require('./inAppVoice') as typeof import('./inAppVoice')).inAppCallActive(),
  navigation: (require('../navigation/navigationRef') as typeof import('../navigation/navigationRef')).navigationRef as unknown as OtaCatchUpNative['navigation'],
});
/* eslint-enable @typescript-eslint/no-require-imports */

/** Earner intents: their sign-in is the app's front door, never the middle of an order. */
const EARNER_INTENTS: readonly string[] = ['vendor', 'mover', 'advertiser'];

let controller: OtaCatchUp | null = null;

/**
 * [OTA-CATCH-UP] Install once at app start (RootNavigator): a downloaded update applies at the
 * first moment that cuts nothing (lib/otaCatchUp.ts). Off where updates are off (a development
 * build, a build without a project id). Best-effort: a missing native piece installs nothing.
 */
// eslint-disable-next-line no-undef -- React Native's global (absent in tests)
export function installOtaCatchUp(load: () => OtaCatchUpNative = loadNative, dev = typeof __DEV__ !== 'undefined' && __DEV__): () => void {
  if (controller || dev) return () => undefined;
  let native: OtaCatchUpNative;
  try {
    native = load();
  } catch {
    return () => undefined;
  }
  const { Updates, AppState, navigation } = native;
  if (!Updates?.isEnabled) return () => undefined;
  const c = createOtaCatchUp({
    now: () => Date.now(),
    pending: () => Updates.latestContext?.isUpdatePending === true,
    busy: () => native.inAppCallActive() || native.isMutating() > 0 || Updates.latestContext?.isRestarting === true,
    route: () => (navigation.isReady() ? navigation.getCurrentRoute()?.name ?? null : null),
    reload: () => Updates.reloadAsync(),
    checkAndFetch: async () => {
      const found = await Updates.checkForUpdateAsync();
      if (found.isAvailable) await Updates.fetchUpdateAsync();
    },
  });
  controller = c;
  const stops: Array<() => void> = [];
  try {
    const sub = Updates.addUpdatesStateChangeListener(() => { c.evaluate(); });
    stops.push(() => sub.remove());
  } catch { /* no updates module: nothing to apply */ }
  try {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') c.foregrounded();
      else if (state === 'background') c.backgrounded();
    });
    stops.push(() => sub.remove());
  } catch { /* no AppState: launch and sign-in still apply */ }
  try {
    // Reaching a resting screen inside a window (the store's board after sign-in) is a moment too.
    stops.push(navigation.addListener('state', () => { c.evaluate(); }));
  } catch { /* navigation not mounted: the other moments still apply */ }
  c.evaluate();
  return () => {
    controller = null;
    for (const stop of stops) stop();
  };
}

/** A sign-in finished: an earner's opens a window (a customer's may be mid-checkout, so it does not). */
export function otaSignedIn(intent: string | null | undefined): void {
  if (controller && intent && EARNER_INTENTS.includes(intent)) controller.earnerSignedIn();
}
