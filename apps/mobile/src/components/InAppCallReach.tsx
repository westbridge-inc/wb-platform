import { useEffect, useState } from 'react';
import { AppState, PermissionsAndroid } from 'react-native';
import { useLiveOrders } from '../hooks/customer';
import { loadInAppConfig } from '../hooks/useInAppCall';
import { isReachKey, reachSignalFromCache } from '../lib/inAppReach';
import { queryClient } from '../lib/queryClient';
import { accountHoldsRole } from '../lib/roleLanding';
import {
  LAUNCH_QUIET_MS,
  REACH_RETRY_MS,
  callsAskMomentOpen,
  createInAppReach,
  onCallsAskMoment,
  sinceLaunch,
  type InAppReach,
  type MicAnswer,
  type ReachDeps,
} from '../services/inAppReach';
import { mayBeRegistered, inAppVoiceAvailable, registerForInAppCallsResult, unregisterInAppCalls, voicePlatform } from '../services/inAppVoice';
import { answerCallsMicrophone, askCallsMicrophone, primeCardShowing, usePrimeStore } from '../services/notification-priming';
import { useAuthStore } from '../stores/authStore';
import { onUpdateGateChange, updateGateShowing } from './UpdateRequiredGate';

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

async function requestMic(): Promise<MicAnswer> {
  const answer = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  if (answer === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  return answer === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'never_ask_again' : 'denied';
}

/** The terms to accept again are on screen, or not yet known for this session: no other question meanwhile. */
function legalGatePending(): boolean {
  const reads = queryClient.getQueriesData<{ needsAcceptance?: boolean }>({ queryKey: ['legal-acceptance'] });
  const generation = useAuthStore.getState().sessionGeneration;
  const mine = reads.find(([key]) => key[1] === generation);
  return !mine || !mine[1] || mine[1].needsAcceptance === true;
}

/** [review S2-2] A fitting moment: a call-relevant screen drawn and in front, settled after launch, signed in, no gate,
 *  no other card. */
export function callsAskMomentNow(): boolean {
  return callsAskMomentOpen()
    && AppState.currentState === 'active'
    && sinceLaunch() >= LAUNCH_QUIET_MS
    && useAuthStore.getState().isAuthenticated
    && !legalGatePending()
    && !updateGateShowing()
    && !primeCardShowing();
}

export function appReachDeps(): ReachDeps {
  return {
    available: inAppVoiceAvailable,
    enabled: async () => (await loadInAppConfig())?.enabled === true,
    register: (force) => registerForInAppCallsResult(async (platform, purpose) => (await (await calls()).appToken(platform, purpose)).data.data.token, { force }),
    unregister: () => unregisterInAppCalls(async (platform) => (await (await calls()).appToken(platform, 'unregister')).data.data.token),
    mayBeRegistered,
    platform: voicePlatform,
    micGranted: () => PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO),
    askMoment: callsAskMomentNow,
    ask: askCallsMicrophone,
    cancelAsk: () => answerCallsMicrophone('dismissed'),
    requestMic,
    memory: micMemory(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

let reach: InAppReach | null = null;
const appReach = () => (reach ??= createInAppReach(appReachDeps()));

export function InAppCallReach(): null {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  const user = useAuthStore((s) => s.user) as Parameters<typeof accountHoldsRole>[0];
  const holdsStore = accountHoldsRole(user, 'vendor');
  const holdsMover = accountHoldsRole(user, 'mover');
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
    const roles = { store: holdsStore, mover: holdsMover };
    // The board and the job reads change every few seconds: the same answer is passed on at most once a minute
    // (the register keeps its own ten-minute rhythm), a changed one at once.
    let last = '';
    let lastAt = 0;
    let stopped = false;
    const run = (always: boolean) => {
      // [review S2-1] Read AFTER the event's own tick: a sign-out or account switch clears the cache before (switch)
      // or after (sign-out) it changes the session, so a clear's events are seen only once the session has moved
      // on, and are dropped. Only this session's own reads ever count.
      setTimeout(() => {
        const auth = useAuthStore.getState();
        if (stopped || !auth.isAuthenticated || auth.sessionGeneration !== sessionGeneration) return;
        const signal = reachSignalFromCache(queryClient, roles);
        const key = `${signal.state}:${signal.orderIds.join(',')}`;
        const now = Date.now();
        if (!always && key === last && now - lastAt < REACH_RETRY_MS) return;
        last = key;
        lastAt = now;
        void appReach().update(signal);
      }, 0);
    };
    run(true);
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' && event.type !== 'added' && event.type !== 'removed') return;
      if (isReachKey(event.query.queryKey)) run(false);
      // [follow-up 2] The terms answer arrived or changed: a microphone ask held back by it may go now.
      else if (event.query.queryKey[0] === 'legal-acceptance') run(true);
    });
    // [follow-up 2] Run again the moment each thing that holds the Android microphone ask back is gone: a fitting
    // screen opens, the launch quiet ends (a cold start straight into order tracking from a push tap), the card
    // slot frees up, the update gate closes. Asking is still the controller's call (never twice, never a nag).
    const offMoment = onCallsAskMoment(() => run(true));
    const quietLeft = LAUNCH_QUIET_MS - sinceLaunch();
    const launchTimer = quietLeft > 0 ? setTimeout(() => run(true), quietLeft + 50) : undefined;
    const offSlot = usePrimeStore.subscribe((state, previous) => {
      const busy = (x: typeof state) => x.visibleMoment != null || x.micAsk != null;
      if (busy(previous) && !busy(state)) run(true);
    });
    const offGate = onUpdateGateChange(() => { if (!updateGateShowing()) run(true); });
    return () => {
      stopped = true;
      unsubscribe();
      offMoment();
      if (launchTimer) clearTimeout(launchTimer);
      offSlot();
      offGate();
    };
  }, [signedIn, enabled, front, sessionGeneration, holdsStore, holdsMover]);

  return null;
}
