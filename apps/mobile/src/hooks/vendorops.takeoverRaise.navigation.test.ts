/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [STORE-ALERT-RECONNECT] The store's new-order screen no longer hangs on the
// socket alone. With the socket dropped (an older API ended it at each token
// refresh), only the OS banner was left and an open order was never raised on
// the phone again. The REAL useVendorOrdersLive on a real renderer and query
// cache: the board's read, the app returning to the screen and a push that
// arrives while the store app is open raise it; once per order; never one
// answered here; never in a loop.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  socketHandlers: new Map<string, Set<(payload?: any) => void>>(),
  renders: 0,
  session: null as null | { userId: string },
}));

vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('../services/api', () => ({ vendorApi: {}, vendorDiscoveryApi: {}, customerApi: {} }));
vi.mock('../services/socket', () => ({
  connectSocket: vi.fn(),
  getSocket: () => ({
    connected: true,
    emit: vi.fn(),
    on: (event: string, cb: (payload?: any) => void) => { (fx.socketHandlers.get(event) ?? fx.socketHandlers.set(event, new Set()).get(event)!).add(cb); },
    off: (event: string, cb: (payload?: any) => void) => { fx.socketHandlers.get(event)?.delete(cb); },
  }),
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({}),
  getAuthSessionSnapshot: () => fx.session, requireAuthSessionForPrincipal: () => null, requireAuthSessionSnapshot: () => null,
}));
vi.mock('../lib/billingMutation', () => ({ runBillingMutation: vi.fn() }));
vi.mock('./cashSettlement', () => ({ confirmVendorCashSettlement: vi.fn() }));
vi.mock('./partnerPricing', () => ({ usePartnerPricing: vi.fn() }));
vi.mock('../stores/storeSwitcher', () => ({
  useStoreSwitcher: Object.assign((selector?: (s: unknown) => unknown) => (selector ? selector({ selectedStoreId: 'store-a' }) : { selectedStoreId: 'store-a' }), {
    getState: () => ({ selectedStoreId: 'store-a', storeGeneration: 1 }),
  }),
}));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (selector: (s: { previewType: null }) => unknown) => selector({ previewType: null }) }));

import { useVendorOrdersLive } from './vendorops';
import { resetHandledTakeovers } from '../modules/vendor/takeoverRaise';
import { bindHandledTakeoverStorage, forgetHandledTakeovers } from '../lib/handledTakeovers';
import { emitAppForeground, emitForegroundPush } from '../lib/appSignals';

type Entry = { orderId: string; orderNumber?: string };
let root: { render: (n: React.ReactNode) => void; unmount: () => void } | null = null;
let host: HTMLElement | null = null;
let qc: QueryClient;
const seen: { takeover: Entry[]; dismiss: (orderId: string) => void } = { takeover: [], dismiss: () => {} };

function Layer() {
  fx.renders += 1;
  const { takeover, dismissTakeover } = useVendorOrdersLive('store-a', true);
  seen.takeover = takeover;
  seen.dismiss = dismissTakeover;
  return null;
}
async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(Layer))); });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const board = (rows: unknown[]) => act(async () => { qc.setQueryData(['vendor', 'orders'], rows); });
const pending = (id: string, extra: Record<string, unknown> = {}) => ({ id, orderNumber: id.toUpperCase(), status: 'PENDING', vendorId: 'store-a', items: [{ id: `${id}-l1`, subStatus: 'NONE' }], ...extra });
const fireSocket = (event: string, payload?: unknown) => act(async () => { for (const cb of [...(fx.socketHandlers.get(event) ?? [])]) cb(payload); });

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seen.takeover = [];
  fx.renders = 0;
  fx.socketHandlers.clear();
  fx.session = null;
  resetHandledTakeovers();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
  bindHandledTakeoverStorage(null);
  vi.restoreAllMocks();
});

describe('[STORE-ALERT-RECONNECT] the board\'s read raises the new-order screen', () => {
  it('a waiting order the board shows is raised though its order:new never arrived (RED before: only the socket raised it)', async () => {
    qc.setQueryData(['vendor', 'orders'], []);
    await mount();
    expect(seen.takeover).toEqual([]);
    await board([pending('o1'), { ...pending('o2'), status: 'ACCEPTED' }]);
    expect(seen.takeover).toEqual([{ orderId: 'o1', orderNumber: 'O1' }]);
  });

  it('every poll after that: one entry per order, the queue stays put, and no render loop', async () => {
    qc.setQueryData(['vendor', 'orders'], [pending('o1')]);
    await mount();
    const first = seen.takeover;
    const rendersAfterRaise = fx.renders;
    for (let i = 0; i < 20; i += 1) await board([pending('o1')]);
    await flush();
    expect(seen.takeover).toBe(first); // the same array: the queue never changed
    // React may render once more before it bails out of an unchanged state; never once per poll.
    expect(fx.renders).toBeLessThanOrEqual(rendersAfterRaise + 1);
  });

  it('the socket\'s order:new and the board\'s read of the same order: one entry', async () => {
    qc.setQueryData(['vendor', 'orders'], []);
    await mount();
    await fireSocket('order:new', { orderId: 'o1', orderNumber: 'O1' });
    await board([pending('o1')]);
    expect(seen.takeover).toEqual([{ orderId: 'o1', orderNumber: 'O1' }]);
  });

  it('respects the store\'s answer: one dismissed here ("View later", Accept, Reject) is not raised again by the board', async () => {
    qc.setQueryData(['vendor', 'orders'], [pending('o1')]);
    await mount();
    await act(async () => { seen.dismiss('o1'); });
    await board([pending('o1')]);
    await board([pending('o1'), pending('o3')]);
    expect(seen.takeover).toEqual([{ orderId: 'o3', orderNumber: 'O3' }]);
  });

  it('never an order waiting on the customer, one past its accept window, another branch\'s, or one with a store tap in flight', async () => {
    qc.setQueryData(['vendor', 'orders'], []);
    await mount();
    let release!: () => void;
    const inFlight = qc.getMutationCache().build(qc, { mutationFn: () => new Promise<void>((r) => { release = r; }) });
    const running = inFlight.execute({ id: 'o-busy' });
    await board([
      pending('o-asked', { items: [{ id: 'l', subStatus: 'PENDING', substituteName: null }] }),
      pending('o-late', { respondBy: new Date(Date.now() - 1_000).toISOString() }),
      pending('o-branch', { vendorId: 'store-b' }),
      pending('o-busy'),
      pending('o-ok', { respondBy: new Date(Date.now() + 60_000).toISOString() }),
    ]);
    expect(seen.takeover).toEqual([{ orderId: 'o-ok', orderNumber: 'O-OK' }]);
    release();
    await act(async () => { await running; });
  });
});

describe('[STORE-ALERT-RECONNECT] the app returns to the screen', () => {
  it('re-reads the board at once (the read raises what waits)', async () => {
    qc.setQueryData(['vendor', 'orders'], []);
    await mount();
    const refetch = vi.spyOn(qc, 'refetchQueries').mockResolvedValue(undefined);
    await act(async () => { emitAppForeground(); });
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['vendor', 'orders'], exact: true });
    await board([pending('o9')]);
    expect(seen.takeover).toEqual([{ orderId: 'o9', orderNumber: 'O9' }]);
  });

  it('unmounted: the layer no longer listens', async () => {
    qc.setQueryData(['vendor', 'orders'], []);
    await mount();
    const refetch = vi.spyOn(qc, 'refetchQueries').mockResolvedValue(undefined);
    act(() => root?.unmount());
    root = null;
    emitAppForeground();
    emitForegroundPush({ kind: 'vendor_order_alert', orderId: 'o1' });
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe('[STORE-ALERT-RECONNECT] a new-order push while the store app is open', () => {
  it('raises its order at once and re-reads the board', async () => {
    qc.setQueryData(['vendor', 'orders'], []);
    await mount();
    const refetch = vi.spyOn(qc, 'refetchQueries').mockResolvedValue(undefined);
    await act(async () => { emitForegroundPush({ kind: 'vendor_order_alert', orderId: 'o5', orderNumber: 'O5', vendorId: 'store-a', audience: 'business' }); });
    expect(seen.takeover).toEqual([{ orderId: 'o5', orderNumber: 'O5' }]);
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['vendor', 'orders'], exact: true });
    // The same push again (a duplicate delivery): still one entry.
    await act(async () => { emitForegroundPush({ kind: 'vendor_order_alert', orderId: 'o5', orderNumber: 'O5', vendorId: 'store-a' }); });
    expect(seen.takeover).toEqual([{ orderId: 'o5', orderNumber: 'O5' }]);
  });

  it('[review S3] a push naming no store is not raised by itself (it could be branch B\'s): it re-reads, and the board decides', async () => {
    qc.setQueryData(['vendor', 'orders'], []);
    await mount();
    const refetch = vi.spyOn(qc, 'refetchQueries').mockResolvedValue(undefined);
    await act(async () => { emitForegroundPush({ kind: 'vendor_order_alert', orderId: 'b-order', orderNumber: 'B1' }); });
    expect(seen.takeover).toEqual([]);
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['vendor', 'orders'], exact: true });
    // The re-read shows it is another branch's: still nothing; this store's own waiting order rises.
    await board([pending('b-order', { vendorId: 'store-b' }), pending('a-order')]);
    expect(seen.takeover).toEqual([{ orderId: 'a-order', orderNumber: 'A-ORDER' }]);
  });

  it('ignores other kinds, another branch\'s order, and an order answered here', async () => {
    qc.setQueryData(['vendor', 'orders'], [pending('o1')]);
    await mount();
    await act(async () => { seen.dismiss('o1'); });
    vi.spyOn(qc, 'refetchQueries').mockResolvedValue(undefined);
    await act(async () => {
      emitForegroundPush({ kind: 'order_update', orderId: 'o2' });
      emitForegroundPush({ kind: 'vendor_order_alert', orderId: 'o3', vendorId: 'store-b' });
      emitForegroundPush({ kind: 'vendor_order_alert', orderId: 'o1', vendorId: 'store-a' });
      emitForegroundPush({ kind: 'vendor_order_alert', vendorId: 'store-a' });
    });
    expect(seen.takeover).toEqual([]);
  });
});

describe('[STORE-ALERT-RECONNECT] the store room comes back', () => {
  it('a reconnect after a drop re-reads the board', async () => {
    qc.setQueryData(['vendor', 'orders'], []);
    await mount();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    await fireSocket('disconnect');
    invalidate.mockClear();
    await fireSocket('connect');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vendor', 'orders'] });
  });
});

// [S4-2] What the store answered is kept on the device per signed-in account: a restart (cold start,
// app update) does not ring again for an order put off with "View later"; another account does.
describe('[S4-2] the store\'s answer survives a restart, per account', () => {
  const restart = async () => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    resetHandledTakeovers(); // this run's memory is gone; the device keeps its copy
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  };

  it('"View later", then a restart: the board does not raise it again; another account would', async () => {
    const kv = new Map<string, string>();
    bindHandledTakeoverStorage({ getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => { kv.set(k, v); }, removeItem: (k) => { kv.delete(k); } });
    fx.session = { userId: 'owner-1' };
    const respondBy = new Date(Date.now() + 10 * 60_000).toISOString();
    qc.setQueryData(['vendor', 'orders'], [pending('o1', { respondBy })]);
    await mount();
    expect(seen.takeover).toEqual([{ orderId: 'o1', orderNumber: 'O1' }]);
    await act(async () => { seen.dismiss('o1'); });
    expect(seen.takeover).toEqual([]);

    await restart();
    qc.setQueryData(['vendor', 'orders'], [pending('o1', { respondBy })]);
    await mount();
    expect(seen.takeover).toEqual([]); // RED before: rang again after every restart

    await restart();
    fx.session = { userId: 'owner-2' };
    qc.setQueryData(['vendor', 'orders'], [pending('o1', { respondBy })]);
    await mount();
    expect(seen.takeover).toEqual([{ orderId: 'o1', orderNumber: 'O1' }]); // never shared across accounts
  });

  it('signed out and back in: it rings again (sign-out wipes the memory)', async () => {
    const kv = new Map<string, string>();
    bindHandledTakeoverStorage({ getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => { kv.set(k, v); }, removeItem: (k) => { kv.delete(k); } });
    fx.session = { userId: 'owner-1' };
    qc.setQueryData(['vendor', 'orders'], [pending('o1')]);
    await mount();
    await act(async () => { seen.dismiss('o1'); });
    expect(kv.size).toBe(1);
    await restart();
    forgetHandledTakeovers();
    expect(kv.size).toBe(0);
    qc.setQueryData(['vendor', 'orders'], [pending('o1')]);
    await mount();
    expect(seen.takeover).toEqual([{ orderId: 'o1', orderNumber: 'O1' }]);
  });

  it('an order the board shows left PENDING is forgotten on the device', async () => {
    const kv = new Map<string, string>();
    bindHandledTakeoverStorage({ getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => { kv.set(k, v); }, removeItem: (k) => { kv.delete(k); } });
    fx.session = { userId: 'owner-1' };
    qc.setQueryData(['vendor', 'orders'], [pending('o1')]);
    await mount();
    await act(async () => { seen.dismiss('o1'); });
    expect(kv.size).toBe(1);
    await board([{ ...pending('o1'), status: 'ACCEPTED' }]);
    expect(kv.size).toBe(0);
  });
});
