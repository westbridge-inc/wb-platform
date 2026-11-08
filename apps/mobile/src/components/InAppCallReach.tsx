import { useEffect, useState } from 'react';
import { Alert, AppState, PermissionsAndroid } from 'react-native';
import { useLiveOrders } from '../hooks/customer';
import { loadInAppConfig } from '../hooks/useInAppCall';
import { isReachKey, reachSignalFromCache } from '../lib/inAppReach';
import { queryClient } from '../lib/queryClient';
import { REACH_RETRY_MS, createInAppReach, type InAppReach, type MicAnswer, type ReachDeps } from '../services/inAppReach';
import { inAppVoiceAvailable, registerForInAppCalls, unregisterInAppCalls, voicePlatform } from '../services/inAppVoice';
import { useAuthStore } from '../stores/authStore';

// ---------------------------------------------------------------------------
// [CALLS-REACH · live test 8 Nov 2026] App-wide: a phone on a live order can be rung in the app, not only
// while a "Call in app" control is on screen (services/inAppReach). Renders nothing.
//
// Reads: the server switch (cached), and the customer's live orders ONCE (the same query the Activity list
// and Profile use, no poll; refreshed when an order is placed). Everything else is what the app already holds
// (a passenger's ride, a mover's active job, the store board), watched in memory, never fetched or polled here.
// Builds 11/12 (no calling module): nothing, not even a read.
// ---------------------------------------------------------------------------

/** Loaded on first use: the API client is not pulled in at import. */
const calls = async () => (await import('../services/api')).callsApi;

/** A plain (not encrypted) on-device slot for "the person said no to the microphone": ids and a time, nothing personal.
 *  If the storage is unavailable, the answer is kept for this run, so Swift still never asks twice. */
function micMemory(): ReachDeps['memory'] {
  let kept: string | null = null;
  let store: { getString(k: string): string | undefined; set(k: string, v: string): void } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MMKV } = require('react-native-mmkv') as { MMKV: new (o: { id: string }) => NonNullable<typeof store> };
    store = new MMKV({ id: 'swift-inapp-calls' });
  } catch {
    store = null;
  }
  return {
    get: () => {
      try { return store?.getString('micAsk') ?? kept; } catch { return kept; }
    },
    set: (value) => {
      kept = value;
      try { store?.set('micAsk', value); } catch { /* kept for this run */ }
    },
  };
}

/** Swift's own words before Android's bare system prompt. Resolves true on "Continue". */
function explain(title: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, body, [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

async function requestMic(): Promise<MicAnswer> {
  const answer = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  if (answer === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  return answer === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'never_ask_again' : 'denied';
}

export function appReachDeps(): ReachDeps {
  return {
    available: inAppVoiceAvailable,
    enabled: async () => (await loadInAppConfig())?.enabled === true,
    register: () => registerForInAppCalls(async (platform, purpose) => (await (await calls()).appToken(platform, purpose)).data.data.token),
    unregister: () => unregisterInAppCalls(async (platform) => (await (await calls()).appToken(platform, 'unregister')).data.data.token),
    platform: voicePlatform,
    foreground: () => AppState.currentState === 'active',
    micGranted: () => PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO),
    explain,
    requestMic,
    memory: micMemory(),
    now: () => Date.now(),
  };
}

let reach: InAppReach | null = null;
const appReach = () => (reach ??= createInAppReach(appReachDeps()));

export function InAppCallReach(): null {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  const available = inAppVoiceAvailable();
  const signedIn = isAuthenticated && available;
  const [enabled, setEnabled] = useState(false);
  const [front, setFront] = useState(0);

  // A new account (or none): forget the last one's state. The auth teardown already unregistered its phone.
  useEffect(() => { if (available) appReach().reset(); }, [available, sessionGeneration]);

  // Coming back to the screen: the switch may have changed (read again once its five-minute cache is over).
  useEffect(() => {
    if (!signedIn) return undefined;
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') setFront((n) => n + 1); });
    return () => sub.remove();
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) { setEnabled(false); return undefined; }
    let live = true;
    void loadInAppConfig().then((c) => { if (live) setEnabled(c?.enabled === true); });
    return () => { live = false; };
  }, [signedIn, sessionGeneration, front]);

  // The customer's live orders (every vertical, rides included): read once, only while calls are on.
  useLiveOrders(undefined, signedIn && enabled);

  useEffect(() => {
    if (!signedIn || !enabled) return undefined;
    // The board and the job reads change every few seconds: the same answer is passed on at most once a minute
    // (the register keeps its own ten-minute rhythm), a changed one at once.
    let last = '';
    let lastAt = 0;
    const push = () => {
      const signal = reachSignalFromCache(queryClient);
      const key = `${signal.state}:${signal.orderIds.join(',')}`;
      const now = Date.now();
      if (key === last && now - lastAt < REACH_RETRY_MS) return;
      last = key;
      lastAt = now;
      void appReach().update(signal);
    };
    push();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if ((event.type === 'updated' || event.type === 'added' || event.type === 'removed') && isReachKey(event.query.queryKey)) push();
    });
    return unsubscribe;
  }, [signedIn, enabled, front, sessionGeneration]);

  return null;
}
