import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { emitAppForeground, emitForegroundPush } from '../lib/appSignals';

let installed = false;

/**
 * [STORE-ALERT-RECONNECT] Install once at app start (RootNavigator): the app
 * returning to the screen, and a push arriving while it is on screen, become
 * the signals in lib/appSignals.ts. The OS still shows the push's banner
 * (services/push.ts); this only lets the open app act on it as well.
 * Best-effort: a missing native module installs nothing and never throws.
 */
export function installAppSignals(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const stops: Array<() => void> = [];
  try {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') emitAppForeground();
    });
    stops.push(() => sub.remove());
  } catch { /* no AppState: nothing to signal */ }
  try {
    const sub = Notifications.addNotificationReceivedListener((notification) => {
      emitForegroundPush(notification?.request?.content?.data);
    });
    stops.push(() => sub.remove());
  } catch { /* no notifications module: nothing to signal */ }
  return () => {
    installed = false;
    for (const stop of stops) stop();
  };
}
