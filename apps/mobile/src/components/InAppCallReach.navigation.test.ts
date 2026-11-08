/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// [CALLS-REACH · live test 8 Nov 2026] The app-wide layer, RENDERED (real React, a real QueryClient, the real
// controller and the real priming slot): a signed-in person on a live order registers on any screen; only the
// server's "no live order" unregisters (review S2-1), so an evicted board, another branch, or a sign-out's cache
// clear never does; Android's microphone is asked only at a fitting moment, through the one card slot (S2-2).

const fx = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  appState: 'active',
  appListeners: 0,
  available: true,
  platform: 'ios' as 'ios' | 'android',
  mic: true,
  micAnswer: 'granted',
  registered: false,
  server: 'registered' as string,
  calls: [] as string[],
  liveOrdersArgs: [] as unknown[][],
  configReads: 0,
  sinceLaunch: 60_000,
  gate: false,
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() { return fx.appState; },
    addEventListener: () => { fx.appListeners += 1; return { remove: () => { fx.appListeners -= 1; } }; },
  },
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: 'mic' },
    RESULTS: { GRANTED: 'granted', NEVER_ASK_AGAIN: 'never_ask_again' },
    check: async () => fx.mic,
    request: async () => { fx.calls.push('system-prompt'); if (fx.micAnswer === 'granted') fx.mic = true; return fx.micAnswer; },
  },
}));
vi.mock('react-native-mmkv', () => {
  class MMKV {
    private v = new Map<string, unknown>();
    getBoolean(k: string) { return this.v.get(k) as boolean | undefined; }
    getString(k: string) { return this.v.get(k) as string | undefined; }
    set(k: string, value: unknown) { this.v.set(k, value); }
    delete(k: string) { this.v.delete(k); }
  }
  return { MMKV };
});
vi.mock('../hooks/customer', () => ({ useLiveOrders: (...args: unknown[]) => { fx.liveOrdersArgs.push(args); } }));
vi.mock('../hooks/useInAppCall', () => ({ loadInAppConfig: async () => { fx.configReads += 1; return { enabled: true }; } }));
vi.mock('../lib/queryClient', () => ({ get queryClient() { return fx.client; } }));
vi.mock('./UpdateRequiredGate', () => ({ updateGateShowing: () => fx.gate }));
vi.mock('../services/inAppVoice', () => ({
  inAppVoiceAvailable: () => fx.available,
  mayBeRegistered: () => fx.registered,
  voicePlatform: () => fx.platform,
  registerForInAppCallsResult: async (_fetch: unknown, opts: { force?: boolean } = {}) => {
    fx.calls.push(opts.force ? 'check' : 'register');
    if (fx.server === 'registered') fx.registered = true;
    return fx.server;
  },
  unregisterInAppCalls: async () => { fx.calls.push('unregister'); fx.registered = false; return true; },
}));
vi.mock('../services/inAppReach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/inAppReach')>()),
  sinceLaunch: () => fx.sinceLaunch,
}));
vi.mock('../stores/authStore', async () => {
  const { create } = await import('zustand');
  const useAuthStore = create(() => ({ isAuthenticated: true, sessionGeneration: 1, user: null as unknown }));
  return { useAuthStore };
});

import { QueryClient } from '@tanstack/react-query';
import { InAppCallReach, callsAskMomentNow } from './InAppCallReach';
import { useAuthStore } from '../stores/authStore';
import { closeCallsAskMoment, openCallsAskMoment, resetCallsAskMomentsForTests } from '../services/inAppReach';
import { answerCallsMicrophone, resetPrimingForTests, usePrimeStore } from '../services/notification-priming';
import { INAPP_WORDS } from '../lib/inAppCalls';

const auth = useAuthStore as unknown as { getState(): { sessionGeneration: number }; setState(p: Record<string, unknown>): void };
const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const draw = async () => { await act(async () => root.render(h(InAppCallReach))); };
/** Let the layer's deferred read and the controller's run finish. */
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };
const signIn = (user: unknown = { id: 'u1', roles: ['CUSTOMER'] }) =>
  auth.setState({ isAuthenticated: true, user, sessionGeneration: auth.getState().sessionGeneration + 1 });
const pickup = { items: [{ id: 'o-pickup', status: 'PREPARING', fulfillment: 'PICKUP', riderId: null }], total: 1 };
const owner = { id: 'u2', roles: ['VENDOR_OWNER'] };
/** This session's terms are accepted (the terms gate is not up). */
const termsAccepted = () => fx.client.setQueryData(['legal-acceptance', auth.getState().sessionGeneration], { needsAcceptance: false });

beforeEach(() => {
  fx.client = new QueryClient();
  Object.assign(fx, {
    appState: 'active', appListeners: 0, available: true, platform: 'ios', mic: true, micAnswer: 'granted', registered: false,
    server: 'registered', calls: [], liveOrdersArgs: [], configReads: 0, sinceLaunch: 60_000, gate: false,
  });
  resetCallsAskMomentsForTests();
  resetPrimingForTests();
  signIn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[CALLS-REACH] registers on any screen, while on a live order', () => {
  it('a customer with a store pickup order registers: no call control is rendered anywhere', async () => {
    fx.client.setQueryData(['customer', 'orders', 'live'], pickup);
    await draw();
    await settle();
    expect(fx.calls).toEqual(['register']);
    // the live-order list is the existing read, with no poll (first argument), only while calls are on
    expect(fx.liveOrdersArgs.at(-1)).toEqual([undefined, true]);
  });

  it('an order placed later registers at once; nothing new is fetched for it', async () => {
    fx.client.setQueryData(['customer', 'orders', 'live'], { items: [], total: 0 });
    await draw();
    await settle();
    expect(fx.calls).toEqual([]);
    await act(async () => { fx.client.setQueryData(['customer', 'orders', 'live'], pickup); });
    await settle();
    expect(fx.calls).toEqual(['register']);
    expect(fx.client.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([['customer', 'orders', 'live']]);
  });

  it('the order finished: the server is asked, and only its "no live order" unregisters', async () => {
    fx.client.setQueryData(['customer', 'orders', 'live'], pickup);
    await draw();
    await settle();
    fx.server = 'not-live';
    await act(async () => { fx.client.setQueryData(['customer', 'orders', 'live'], { items: [{ ...pickup.items[0], status: 'COMPLETED' }], total: 1 }); });
    await settle();
    expect(fx.calls).toEqual(['register', 'check', 'unregister']);
  });
});

describe('[CALLS-REACH · review S2-1] never a false unregister', () => {
  it('a store owner whose board is evicted (switched to the customer side for 30 minutes): the server says live, nothing removed', async () => {
    signIn(owner);
    fx.client.setQueryData(['customer', 'orders', 'live'], { items: [], total: 0 });
    fx.client.setQueryData(['vendor', 'orders'], [{ id: 's1', status: 'ACCEPTED' }]);
    await draw();
    await settle();
    await act(async () => { fx.client.removeQueries({ queryKey: ['vendor', 'orders'] }); });
    await settle();
    expect(fx.calls).toEqual(['register', 'check']);
    expect(fx.registered).toBe(true);
  });

  it('a multi-branch owner moves to branch B (nothing open) while branch A has live orders: kept', async () => {
    signIn(owner);
    fx.client.setQueryData(['customer', 'orders', 'live'], { items: [], total: 0 });
    fx.client.setQueryData(['vendor', 'orders'], [{ id: 'a1', status: 'PREPARING' }]);
    await draw();
    await settle();
    await act(async () => { fx.client.setQueryData(['vendor', 'orders'], []); });
    await settle();
    expect(fx.calls).toEqual(['register', 'check']);
    expect(fx.calls).not.toContain('unregister');
  });

  it('sign-out (the session ends, THEN the cache is cleared): the clear is ignored, no check, no unregister here', async () => {
    fx.client.setQueryData(['customer', 'orders', 'live'], pickup);
    await draw();
    await settle();
    await act(async () => {
      auth.setState({ isAuthenticated: false, user: null, sessionGeneration: auth.getState().sessionGeneration + 1 });
      fx.client.clear();
      // the clear's events are read before React has drawn the signed-out tree: only the session check drops them
      await new Promise((r) => setTimeout(r, 5));
    });
    await settle();
    expect(fx.calls).toEqual(['register']);
    expect(fx.liveOrdersArgs.at(-1)).toEqual([undefined, false]);
  });

  it('account switch (the cache is cleared, THEN the new session is set): the clear\'s events are dropped', async () => {
    fx.client.setQueryData(['customer', 'orders', 'live'], pickup);
    await draw();
    await settle();
    await act(async () => {
      fx.client.clear();
      signIn({ id: 'u3', roles: ['CUSTOMER'] });
      await new Promise((r) => setTimeout(r, 5)); // read before React has drawn the new account
    });
    await settle();
    expect(fx.calls).toEqual(['register']);
  });

  it('[S3-3] a cold start, no live order, a phone that registered before: the server is asked once and unregisters it', async () => {
    fx.registered = true; fx.server = 'not-live';
    fx.client.setQueryData(['customer', 'orders', 'live'], { items: [], total: 0 });
    await draw();
    await settle();
    expect(fx.calls).toEqual(['check', 'unregister']);
  });
});

describe('[CALLS-REACH] nothing at all where it must not run', () => {
  it('build 12 (no voice module): no read, no listener, no register', async () => {
    fx.available = false;
    fx.client.setQueryData(['customer', 'orders', 'live'], pickup);
    await draw();
    await settle();
    expect(fx.calls).toEqual([]);
    expect(fx.configReads).toBe(0);
    expect(fx.appListeners).toBe(0);
    expect(fx.liveOrdersArgs.at(-1)).toEqual([undefined, false]);
  });

  it('signed out: nothing', async () => {
    auth.setState({ isAuthenticated: false, user: null });
    fx.client.setQueryData(['customer', 'orders', 'live'], pickup);
    await draw();
    await settle();
    expect(fx.calls).toEqual([]);
  });
});

describe('[CALLS-REACH · review S2-2] Android\'s microphone: only at a fitting moment, through the one card slot', () => {
  beforeEach(() => { fx.platform = 'android'; fx.mic = false; });

  it('not on a fitting screen: no card; the order-tracking screen opens the moment, the card shows, Continue -> system prompt -> register', async () => {
    termsAccepted();
    fx.client.setQueryData(['customer', 'orders', 'live'], pickup);
    await draw();
    await settle();
    expect(usePrimeStore.getState().micAsk).toBeNull();
    expect(fx.calls).toEqual([]);
    let token = 0;
    await act(async () => { token = openCallsAskMoment(); });
    await settle();
    expect(usePrimeStore.getState().micAsk).toBe('customer');
    await act(async () => { answerCallsMicrophone('allow'); });
    await settle();
    expect(fx.calls).toEqual(['system-prompt', 'register']);
    closeCallsAskMoment(token);
  });

  it('the moment is open but the notifications card is showing: waits, never two cards', async () => {
    termsAccepted();
    usePrimeStore.getState().show('customer_order');
    openCallsAskMoment();
    fx.client.setQueryData(['customer', 'orders', 'live'], pickup);
    await draw();
    await settle();
    expect(usePrimeStore.getState().micAsk).toBeNull();
    expect(fx.calls).toEqual([]);
  });

  it('the fitting moment, gate by gate: launch, terms, update gate, another card, background, signed out', () => {
    const token = openCallsAskMoment();
    termsAccepted();
    expect(callsAskMomentNow()).toBe(true);
    fx.sinceLaunch = 3_000; expect(callsAskMomentNow()).toBe(false); fx.sinceLaunch = 60_000;
    fx.client.setQueryData(['legal-acceptance', auth.getState().sessionGeneration], { needsAcceptance: true });
    expect(callsAskMomentNow()).toBe(false);
    fx.client.removeQueries({ queryKey: ['legal-acceptance'] }); // not known yet for this session
    expect(callsAskMomentNow()).toBe(false);
    termsAccepted();
    fx.gate = true; expect(callsAskMomentNow()).toBe(false); fx.gate = false;
    usePrimeStore.getState().show('customer_order'); expect(callsAskMomentNow()).toBe(false); usePrimeStore.getState().dismiss();
    fx.appState = 'background'; expect(callsAskMomentNow()).toBe(false); fx.appState = 'active';
    expect(callsAskMomentNow()).toBe(true);
    closeCallsAskMoment(token);
    expect(callsAskMomentNow()).toBe(false);
  });

  it('the card shows the mic words in Swift\'s voice', async () => {
    expect(INAPP_WORDS.reachWhyCustomer).toBe('So the store, rider or driver can call you in Swift, allow the microphone. Swift never records calls.');
  });
});

describe('[CALLS-REACH] mounted once for the whole app', () => {
  it('App renders it inside the query client, beside the other app-wide layers (not on any one screen)', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const inside = app.slice(app.indexOf('<QueryClientProvider client={queryClient}>'), app.indexOf('</QueryClientProvider>'));
    expect(inside.match(/<InAppCallReach \/>/g)).toHaveLength(1);
    expect(app.match(/<InAppCallReach \/>/g)).toHaveLength(1);
  });
});
