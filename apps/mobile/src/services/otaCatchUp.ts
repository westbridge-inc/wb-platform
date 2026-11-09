import { createOtaCatchUp, onOtaHoldsReleased, otaRestartHeld, type OtaCatchUp } from '../lib/otaCatchUp';

/** The native pieces the catch-up reads, loaded when it is installed (never at import: tests and
 *  screens that import the root navigator load no native module through this file). */
export interface OtaCatchUpNative {
  Updates: Pick<typeof import('expo-updates'), 'isEnabled' | 'updateId' | 'latestContext' | 'reloadAsync' | 'checkForUpdateAsync' | 'fetchUpdateAsync' | 'addUpdatesStateChangeListener'>;
  AppState: Pick<typeof import('react-native').AppState, 'addEventListener' | 'currentState'>;
  /** [REVIEW-2 S3-1 on #2431] A notification tap or a Swift link still landing. */
  tapRoutingBusy: () => boolean;
  deepLinkBusy: () => boolean;
  /** [REVIEW-2 L3] The one analytics seam (lib/analytics: no data leaves the phone today). */
  track: (event: string, properties: Record<string, string>) => void;
  /** [REVIEW-2 L2] The splash image (the bundled asset), for the restart screen. */
  splashImage: number | string;
  isMutating: () => number;
  inAppCallActive: () => boolean;
  /** [REVIEW-1 S3-2 on #2431] An in-app call still ringing (not answered yet). */
  inAppCallRinging: () => boolean;
  /** [REVIEW-1 L1 on #2431] A text box has the keyboard (someone is typing). */
  inputFocused: () => boolean;
  navigation: { isReady(): boolean; getCurrentRoute(): { name: string } | undefined; addListener(event: 'state', cb: () => void): () => void };
}

/* eslint-disable @typescript-eslint/no-require-imports -- loaded on install, not at import (see above) */
const loadNative = (): OtaCatchUpNative => ({
  Updates: require('expo-updates'),
  AppState: require('react-native').AppState,
  isMutating: () => (require('../lib/queryClient') as typeof import('../lib/queryClient')).queryClient.isMutating(),
  inAppCallActive: () => (require('./inAppVoice') as typeof import('./inAppVoice')).inAppCallActive(),
  inAppCallRinging: () => (require('./inAppVoice') as typeof import('./inAppVoice')).inAppCallRinging(),
  tapRoutingBusy: () => (require('./notification-router') as typeof import('./notification-router')).tapRoutingBusy(),
  deepLinkBusy: () => (require('./deep-links') as typeof import('./deep-links')).deepLinkBusy(),
  track: (event, properties) => (require('../lib/analytics') as typeof import('../lib/analytics')).track(event, properties),
  splashImage: require('../../assets/icon.png') as number,
  inputFocused: () => {
    const rn = require('react-native') as typeof import('react-native');
    return rn.TextInput?.State?.currentlyFocusedInput?.() != null;
  },
  navigation: (require('../navigation/navigationRef') as typeof import('../navigation/navigationRef')).navigationRef as unknown as OtaCatchUpNative['navigation'],
});
/* eslint-enable @typescript-eslint/no-require-imports */

/** [REVIEW-2 L2 on #2431] The restart looks like Swift's own launch: app.config.ts splash (brand maroon, the icon). */
export const RESTART_SCREEN_BACKGROUND = '#803B3B';

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
  // [REVIEW-2 info] The state-change event's own context, as well as latestContext (an export expo-updates does not
  // document as public).
  let eventContext: { isUpdatePending?: boolean; isRestarting?: boolean; downloadedManifest?: { id?: string } } | null = null;
  const context = () => ({ ...(Updates.latestContext ?? {}), ...(eventContext ?? {}) }) as typeof eventContext;
  const c = createOtaCatchUp({
    now: () => Date.now(),
    pending: () => eventContext?.isUpdatePending === true || Updates.latestContext?.isUpdatePending === true,
    active: () => AppState.currentState === 'active',
    busy: () => native.inAppCallActive() || native.inAppCallRinging() || native.isMutating() > 0 || otaRestartHeld()
      || native.inputFocused() || native.tapRoutingBusy() || native.deepLinkBusy() || context()?.isRestarting === true,
    route: () => (navigation.isReady() ? navigation.getCurrentRoute()?.name ?? null : null),
    reload: () => {
      // [REVIEW-2 L3] One event per catch-up (the restart starts a second app session): from which JS to which.
      try {
        native.track('ota_catch_up', { from: Updates.updateId ?? 'embedded', to: context()?.downloadedManifest?.id ?? 'unknown' });
      } catch { /* telemetry never stops the restart */ }
      return Updates.reloadAsync({
        reloadScreenOptions: { backgroundColor: RESTART_SCREEN_BACKGROUND, image: native.splashImage, imageResizeMode: 'contain', fade: true },
      });
    },
    later: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    checkAndFetch: async () => {
      const found = await Updates.checkForUpdateAsync();
      // [REVIEW-1 L2 on #2431] A roll-back to the built-in JS is fetched (and applied) like a newer update.
      if (found.isAvailable || found.isRollBackToEmbedded) await Updates.fetchUpdateAsync();
    },
  });
  controller = c;
  const stops: Array<() => void> = [];
  try {
    const sub = Updates.addUpdatesStateChangeListener((event) => {
      eventContext = (event?.context ?? null) as typeof eventContext;
      c.evaluate();
    });
    stops.push(() => sub.remove());
  } catch { /* no updates module: nothing to apply */ }
  try {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') c.foregrounded();
      else if (state === 'background') c.backgrounded();
    });
    stops.push(() => sub.remove());
  } catch { /* no AppState: launch and sign-in still apply */ }
  // The new-order alert closed, the typed reference was cleared: look again (inside a window only).
  stops.push(onOtaHoldsReleased(() => { c.evaluate(); }));
  try {
    // Reaching a resting screen inside a window (the store's board after sign-in) is a moment too.
    stops.push(navigation.addListener('state', () => { c.evaluate(); }));
  } catch { /* navigation not mounted: the other moments still apply */ }
  c.evaluate();
  return () => {
    controller = null;
    c.dispose();
    for (const stop of stops) stop();
  };
}

/** A sign-in finished: an earner's opens a window (a customer's may be mid-checkout, so it does not). Only a store's
 *  first screen (the orders board) is a resting one, so in practice only a store restarts there. */
export function otaSignedIn(intent: string | null | undefined): void {
  if (controller && intent && EARNER_INTENTS.includes(intent)) controller.earnerSignedIn();
}
