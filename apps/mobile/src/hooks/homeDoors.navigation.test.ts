/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED D · owner 7 Nov: "you tap the Services tab or Taxi or Groceries —
// it LOADS, then goes to it"] The REAL door reads (hooks/homeDoors) over a real
// query client, with the API answering by hand:
//   - each door's read lands in the very key its screen opens on (Food and
//     Groceries: Search's own browse key, built by the one builder);
//   - bounded: once per freshness window, never while on its way, never a
//     scrolled list cut back to one page, never offline, never a door the
//     person cannot open, one door at a time, stopping when Home is covered;
//   - Home asks them only once it has sat quiet, once per fresh feed.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  getVendors: vi.fn(),
  getFavorites: vi.fn(),
  getOrders: vi.fn(),
  search: vi.fn(),
  active: vi.fn(),
  capabilities: vi.fn(),
  marketItems: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../services/api', () => ({
  customerApi: { getVendors: fx.getVendors, getFavorites: fx.getFavorites, getOrders: fx.getOrders, search: fx.search },
  rideApi: { active: fx.active, capabilities: fx.capabilities },
  marketApi: { items: fx.marketItems }, discoveryApi: {}, moderationApi: {},
  api: { get: fx.get },
}));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/rideRequestAttemptStore', () => ({ rideRequestAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn(), checkoutFailureOutcome: vi.fn(), settleUnresolvedIntent: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../stores/authStore', () => {
  const state = { isAuthenticated: true, sessionGeneration: 1, user: { id: 'customer-1' } };
  return {
    useAuthStore: Object.assign((select?: (s: typeof state) => unknown) => (select ? select(state) : state), { getState: () => state }),
    getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: vi.fn(), requireAuthSessionSnapshot: vi.fn(), AuthSessionBoundaryError: class extends Error {},
  };
});

import { customerKeys, ordersHistoryRead } from './customer';
import { searchBrowseParams } from '../lib/searchBrowse';
import {
  DOOR_FRESH_MS,
  HOME_DOORS,
  HOME_DOORS_IDLE_MS,
  doorStoreListKey,
  readCategoryFeed,
  readCategorySearch,
  readDoor,
  readDoorsInTurn,
  useHomeDoorReads,
  type DoorContext,
} from './homeDoors';

const answer = (data: unknown) => ({ data: { data } });
const later = () => {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const HERE = { latitude: 6.8, longitude: -58.16 };
const SIGNED_IN: DoorContext = { signedIn: true, here: HERE, marketVisible: true };
const GUEST: DoorContext = { signedIn: false, here: null, marketVisible: false };
const CATALOG = { version: 1, categories: [{ id: 'plumber', label: 'Plumber', group: 'HOME_AND_TRADES' }] };

let client: QueryClient;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };

function answerEverything() {
  fx.getVendors.mockImplementation((params: unknown) => Promise.resolve(answer([{ id: 'store-1', name: 'Store 1', params }])));
  fx.getFavorites.mockResolvedValue(answer([{ id: 'store-2' }]));
  fx.getOrders.mockImplementation((page: number) => Promise.resolve({ data: { data: [{ id: `order-${page}` }], meta: { page, totalPages: 3, total: 1 } } }));
  fx.search.mockResolvedValue(answer({ vendors: [], items: [] }));
  fx.active.mockResolvedValue(answer(null));
  fx.capabilities.mockResolvedValue(answer({ maxStops: 2 }));
  fx.marketItems.mockResolvedValue(answer({ items: [{ id: 'thing-1' }], nextCursor: null }));
  fx.get.mockResolvedValue({ data: { data: CATALOG } });
}

beforeEach(() => {
  vi.clearAllMocks();
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  answerEverything();
});
afterEach(() => {
  client.clear();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe('[APP-SPEED D] each door’s read lands in the key its screen opens on', () => {
  it('Food and Groceries: Search’s own browse key (no words, the tile’s type, the granted place)', async () => {
    await readDoor(client, 'food', SIGNED_IN);
    await readDoor(client, 'groceries', SIGNED_IN);
    // What SearchScreen asks for on a tile's first frame: debounced '' , the preset type, no sort, Open now off.
    const searchFood = customerKeys.vendors(searchBrowseParams({ text: '', type: 'RESTAURANT', sort: undefined, openNow: false, latitude: HERE.latitude, longitude: HERE.longitude }));
    const searchGroceries = customerKeys.vendors(searchBrowseParams({ text: '', type: 'SUPERMARKET', sort: undefined, openNow: false, latitude: HERE.latitude, longitude: HERE.longitude }));
    expect(doorStoreListKey('RESTAURANT', HERE).queryKey).toEqual(searchFood);
    expect(client.getQueryData(searchFood)).toEqual([expect.objectContaining({ id: 'store-1' })]);
    expect(client.getQueryData(searchGroceries)).toEqual([expect.objectContaining({ id: 'store-1' })]);
    expect(fx.getVendors).toHaveBeenNthCalledWith(1, { type: 'RESTAURANT', lat: '6.8', lng: '-58.16' });
    expect(fx.getVendors).toHaveBeenNthCalledWith(2, { type: 'SUPERMARKET', lat: '6.8', lng: '-58.16' });
  });

  it('Services, Taxi, Orders, Favourites, the Market tab: the screens’ own keys', async () => {
    for (const door of HOME_DOORS) await readDoor(client, door, SIGNED_IN);
    expect(client.getQueryData(['services', 'catalog', 1])).toEqual(CATALOG);
    expect(client.getQueryState(['rides', 'active'])?.status).toBe('success');
    expect(client.getQueryData(['rides', 'capabilities'])).toEqual({ maxStops: 2 });
    expect(client.getQueryData([...customerKeys.orders, 'live'])).toEqual({ items: [{ id: 'order-1' }], total: 1 });
    expect((client.getQueryData(ordersHistoryRead().queryKey) as { pages: unknown[] }).pages).toHaveLength(1);
    expect(client.getQueryData(['customer', 'favorites'])).toEqual([{ id: 'store-2' }]);
    expect((client.getQueryData(['market', 'items', 'all', 'new']) as { pages: unknown[] }).pages).toHaveLength(1);
  });

  it('a category tile and a rail chip: Search’s engine key and the category feed’s key', async () => {
    await readCategorySearch(client, ' Pepperpot ', HERE);
    expect(client.getQueryState(customerKeys.search('Pepperpot', undefined, HERE.latitude, HERE.longitude))?.status).toBe('success');
    await readCategoryFeed(client, 'roti', HERE);
    expect(client.getQueryState(customerKeys.vendors({ category: 'roti', lat: '6.8', lng: '-58.16' }))?.status).toBe('success');
    expect(readCategorySearch(client, 'a', HERE), 'a one-letter search is never asked (Search does not ask it either)').toBeUndefined();
  });
});

describe('[APP-SPEED D] bounded: data cost and honesty', () => {
  it('once per freshness window, and never while the same read is on its way', async () => {
    const first = later();
    fx.get.mockImplementationOnce(() => first.promise);
    const asked = readDoor(client, 'services', SIGNED_IN);
    expect(readDoor(client, 'services', SIGNED_IN), 'on its way: not asked twice').toBeUndefined();
    first.resolve({ data: { data: CATALOG } });
    await asked;
    expect(readDoor(client, 'services', SIGNED_IN), 'fresh: not asked again').toBeUndefined();
    expect(fx.get).toHaveBeenCalledTimes(1);

    // The same answer, older than the window: asked again.
    client.setQueryData(['services', 'catalog', 1], CATALOG, { updatedAt: Date.now() - DOOR_FRESH_MS - 1 });
    await readDoor(client, 'services', SIGNED_IN);
    expect(fx.get).toHaveBeenCalledTimes(2);
  });

  it('a list read page by page is never cut back: asked ahead only when nothing is in memory', async () => {
    const key = ordersHistoryRead().queryKey;
    client.setQueryData(key, { pages: [{ items: [], meta: { page: 1, totalPages: 3 } }, { items: [], meta: { page: 2, totalPages: 3 } }], pageParams: [1, 2] }, { updatedAt: Date.now() - DOOR_FRESH_MS * 10 });
    client.setQueryData([...customerKeys.orders, 'live'], { items: [], total: 0 });
    await readDoor(client, 'orders', SIGNED_IN);
    expect(fx.getOrders).not.toHaveBeenCalled();
    expect((client.getQueryData(key) as { pages: unknown[] }).pages, 'the scrolled pages stay').toHaveLength(2);
  });

  it('a guest’s doors that need an account ask nothing; the open ones still do', async () => {
    for (const door of ['taxi', 'orders', 'favourites', 'market'] as const) expect(readDoor(client, door, GUEST)).toBeUndefined();
    expect(fx.active).not.toHaveBeenCalled();
    expect(fx.getOrders).not.toHaveBeenCalled();
    expect(fx.getFavorites).not.toHaveBeenCalled();
    expect(fx.marketItems, 'the Market tab is not shown: nothing read for it').not.toHaveBeenCalled();
    await readDoor(client, 'food', GUEST);
    expect(fx.getVendors).toHaveBeenCalledWith({ type: 'RESTAURANT' });
  });

  it('offline: nothing is asked', () => {
    onlineManager.setOnline(false);
    for (const door of HOME_DOORS) expect(readDoor(client, door, SIGNED_IN)).toBeUndefined();
    expect(readCategoryFeed(client, 'roti', HERE)).toBeUndefined();
    expect(fx.getVendors).not.toHaveBeenCalled();
    expect(fx.get).not.toHaveBeenCalled();
  });

  it('a failed read ahead settles, is not retried, and leaves a failure, never an empty answer, for the screen', async () => {
    fx.get.mockRejectedValueOnce(new Error('network'));
    await expect(readDoor(client, 'services', SIGNED_IN)).resolves.toBeUndefined();
    expect(fx.get).toHaveBeenCalledTimes(1);
    const state = client.getQueryState(['services', 'catalog', 1]);
    expect(state?.status).toBe('error');
    expect(state?.data).toBeUndefined();
  });

  it('one door at a time, in turn, and the turn stops the moment Home is covered', async () => {
    const food = later();
    fx.getVendors.mockImplementationOnce(() => food.promise);
    let wanted = true;
    const turn = readDoorsInTurn(client, ['food', 'groceries', 'services'], SIGNED_IN, () => wanted);
    await flush();
    expect(fx.getVendors).toHaveBeenCalledTimes(1);
    expect(fx.get, 'the next door waits for the last').not.toHaveBeenCalled();
    wanted = false;
    food.resolve(answer([]));
    await turn;
    expect(fx.getVendors, 'covered: Groceries is not asked').toHaveBeenCalledTimes(1);
    expect(fx.get).not.toHaveBeenCalled();
  });
});

describe('[APP-SPEED D] Home asks them once it has sat quiet, once per fresh feed', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  async function draw(enabled: boolean, feedAt: number) {
    function Probe() { useHomeDoorReads(enabled, feedAt, SIGNED_IN); return null; }
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))));
  }
  const quiet = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  it('nothing before the quiet moment; then every door; never twice for the same feed; again for a new feed', async () => {
    vi.useFakeTimers();
    await draw(true, 1000);
    await quiet(HOME_DOORS_IDLE_MS - 10);
    expect(fx.active).not.toHaveBeenCalled();
    await quiet(20);
    await quiet(50);
    expect(fx.active, 'Taxi first: "is a ride in progress?"').toHaveBeenCalledTimes(1);
    expect(fx.getVendors).toHaveBeenCalledTimes(2);
    expect(fx.get).toHaveBeenCalledTimes(1);
    expect(fx.marketItems).toHaveBeenCalledTimes(1);

    await draw(true, 1000);
    await quiet(HOME_DOORS_IDLE_MS * 2);
    expect(fx.getVendors, 'the same feed: no second pass').toHaveBeenCalledTimes(2);

    // A new feed read: a second pass, which asks only what has gone stale.
    client.setQueryData(customerKeys.vendors(searchBrowseParams({ type: 'RESTAURANT', latitude: HERE.latitude, longitude: HERE.longitude })), [], { updatedAt: Date.now() - DOOR_FRESH_MS - 1 });
    await draw(true, 2000);
    await quiet(HOME_DOORS_IDLE_MS + 50);
    expect(fx.getVendors).toHaveBeenCalledTimes(3);
    expect(fx.get, 'the catalogue is still fresh').toHaveBeenCalledTimes(1);
  });

  it('Home covered (or showing no feed): nothing is asked', async () => {
    vi.useFakeTimers();
    await draw(false, 1000);
    await quiet(HOME_DOORS_IDLE_MS * 3);
    expect(fx.active).not.toHaveBeenCalled();
    expect(fx.getVendors).not.toHaveBeenCalled();
  });

  it('a read still on its way holds the pass to the next quiet moment', async () => {
    vi.useFakeTimers();
    const slow = later();
    void client.prefetchQuery({ queryKey: ['ads', 'slow'], queryFn: () => slow.promise });
    await draw(true, 1000);
    await quiet(HOME_DOORS_IDLE_MS * 2 + 10);
    expect(fx.active).not.toHaveBeenCalled();
    slow.resolve('done');
    await quiet(HOME_DOORS_IDLE_MS + 50);
    expect(fx.active).toHaveBeenCalledTimes(1);
  });
});
