import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [CALLS-REACH · live test 8 Nov 2026] The app-wide layer, through the REAL component with a REAL QueryClient:
// a signed-in person on a live order registers on any screen; nothing is fetched or polled for it beyond the
// customer's live-order list read once (no poll); sign-out stops it; build 12 does nothing at all.

const fx = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  effects: [] as Array<() => void | (() => void)>,
  stateAt: 0,
  state: {} as Record<number, unknown>,
  auth: { isAuthenticated: true, sessionGeneration: 1 },
  available: true,
  liveOrdersArgs: [] as unknown[][],
  register: 0,
  unregister: 0,
  configReads: 0,
  appStateListeners: 0,
}));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return {
    ...real,
    useEffect: (effect: () => void | (() => void)) => { fx.effects.push(effect); },
    useState: (v: unknown) => { const at = fx.stateAt++; return [at in fx.state ? fx.state[at] : v, vi.fn()]; },
  };
});
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  AppState: { currentState: 'active', addEventListener: vi.fn(() => { fx.appStateListeners += 1; return { remove: vi.fn() }; }) },
  PermissionsAndroid: { PERMISSIONS: { RECORD_AUDIO: 'mic' }, RESULTS: { GRANTED: 'granted', NEVER_ASK_AGAIN: 'never_ask_again' }, check: vi.fn(async () => true), request: vi.fn() },
  Platform: { OS: 'ios' },
}));
vi.mock('../hooks/customer', () => ({ useLiveOrders: (...args: unknown[]) => { fx.liveOrdersArgs.push(args); } }));
vi.mock('../hooks/useInAppCall', () => ({ loadInAppConfig: async () => { fx.configReads += 1; return { enabled: true }; } }));
vi.mock('../lib/queryClient', () => ({ get queryClient() { return fx.client; } }));
vi.mock('../services/inAppVoice', () => ({
  inAppVoiceAvailable: () => fx.available,
  registerForInAppCalls: async () => { fx.register += 1; return true; },
  unregisterInAppCalls: async () => { fx.unregister += 1; return true; },
  voicePlatform: () => 'ios',
}));
vi.mock('../stores/authStore', () => ({ useAuthStore: (select: (s: typeof fx.auth) => unknown) => select(fx.auth) }));
vi.mock('../services/api', () => ({ callsApi: {} }));

import { QueryClient } from '@tanstack/react-query';
import { InAppCallReach } from './InAppCallReach';

/** One render: the component's hooks run, then its effects (as React would after commit). Returns the cleanups. */
function render(state: { enabled?: boolean } = {}) {
  fx.effects = [];
  fx.stateAt = 0;
  fx.state = state.enabled === undefined ? {} : { 0: state.enabled };
  InAppCallReach();
  return fx.effects.map((effect) => effect()).filter((c): c is () => void => typeof c === 'function');
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const pickupOrder = { items: [{ id: 'o-pickup', status: 'PREPARING', fulfillment: 'PICKUP', riderId: null }], total: 1 };

beforeEach(() => {
  fx.client = new QueryClient();
  fx.auth = { isAuthenticated: true, sessionGeneration: fx.auth.sessionGeneration + 1 };
  fx.available = true;
  fx.liveOrdersArgs = [];
  fx.register = 0; fx.unregister = 0; fx.configReads = 0; fx.appStateListeners = 0;
});

describe('[CALLS-REACH] InAppCallReach (mounted once, in App)', () => {
  it('a customer with a store pickup order registers while on any screen: no call control is rendered anywhere', async () => {
    fx.client.setQueryData(['customer', 'orders', 'live'], pickupOrder);
    render({ enabled: true });
    await settle();
    expect(fx.register).toBe(1);
    // the live-order list is the existing read, once: no poll (first argument), only while calls are on
    expect(fx.liveOrdersArgs).toEqual([[undefined, true]]);
  });

  it('an order placed later (the list refreshes) registers at once; its end unregisters', async () => {
    fx.client.setQueryData(['customer', 'orders', 'live'], { items: [], total: 0 });
    render({ enabled: true });
    await settle();
    expect(fx.register).toBe(0);
    fx.client.setQueryData(['customer', 'orders', 'live'], pickupOrder);
    await settle();
    expect(fx.register).toBe(1);
    fx.client.setQueryData(['customer', 'orders', 'live'], { items: [{ ...pickupOrder.items[0], status: 'COMPLETED' }], total: 1 });
    await settle();
    expect(fx.unregister).toBe(1);
  });

  it('a mover\'s job or the store board, already read by their own screens, is enough (nothing new is fetched)', async () => {
    fx.client.setQueryData(['vendor', 'orders'], [{ id: 's1', status: 'ACCEPTED' }]);
    render({ enabled: true });
    await settle();
    expect(fx.register).toBe(1);
    expect(fx.client.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([['vendor', 'orders']]);
  });

  it('no live order: no register', async () => {
    fx.client.setQueryData(['customer', 'orders', 'live'], { items: [], total: 0 });
    fx.client.setQueryData(['mover', 'active', 'RIDER'], null);
    render({ enabled: true });
    await settle();
    expect(fx.register).toBe(0);
  });

  it('calls off on the server: the live-order list is not even read', async () => {
    render({ enabled: false });
    await settle();
    expect(fx.liveOrdersArgs).toEqual([[undefined, false]]);
    fx.client.setQueryData(['customer', 'orders', 'live'], pickupOrder);
    await settle();
    expect(fx.register).toBe(0);
  });

  it('signed out: nothing; signing out stops the watch (the auth teardown unregisters the phone itself)', async () => {
    const cleanups = render({ enabled: true });
    for (const c of cleanups) c();
    fx.client.setQueryData(['customer', 'orders', 'live'], pickupOrder);
    await settle();
    expect(fx.register).toBe(0);
    fx.auth = { isAuthenticated: false, sessionGeneration: fx.auth.sessionGeneration + 1 };
    render({ enabled: true });
    await settle();
    expect(fx.register).toBe(0);
    expect(fx.liveOrdersArgs.at(-1)).toEqual([undefined, false]);
  });

  it('build 12 (no voice module): no read, no listener, no register', async () => {
    fx.available = false;
    fx.client.setQueryData(['customer', 'orders', 'live'], pickupOrder);
    render({ enabled: true });
    await settle();
    expect(fx.register).toBe(0);
    expect(fx.configReads).toBe(0);
    expect(fx.appStateListeners).toBe(0);
    expect(fx.liveOrdersArgs).toEqual([[undefined, false]]);
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
