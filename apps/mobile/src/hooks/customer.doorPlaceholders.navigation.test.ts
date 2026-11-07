/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED A] The REAL customer hooks over a real query client: what a door
// may draw before its own read lands, and what is asked ahead of a tap.
//   - The Cart tab's first quote: another quote of the same cart stands in,
//     flagged (the screen holds Place order); never an empty cart; never for
//     the store page or the cart bar.
//   - The promo code never sent with the quote read is not part of its key:
//     a code applied does not ask the same quote twice.
//   - An order's list row stands in only for a screen that asked (`preview`).
//   - Press-in reads go only when nothing is in memory or on its way.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  getCart: vi.fn(),
  getOrder: vi.fn(),
  getVendor: vi.fn(),
  active: vi.fn(),
  place: { latitude: 6.8, longitude: -58.16, status: 'granted' as string },
}));

vi.mock('../services/api', () => ({
  customerApi: { getCart: fx.getCart, getOrder: fx.getOrder, getVendor: fx.getVendor },
  rideApi: { active: fx.active },
  marketApi: {}, discoveryApi: {}, moderationApi: {},
}));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn(), checkoutFailureOutcome: vi.fn(), settleUnresolvedIntent: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../stores/authStore', () => {
  const state = { isAuthenticated: true, sessionGeneration: 1, user: { id: 'customer-1' } };
  return {
    useAuthStore: Object.assign((select?: (s: typeof state) => unknown) => (select ? select(state) : state), { getState: () => state }),
    getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: vi.fn(), AuthSessionBoundaryError: class extends Error {},
  };
});
vi.mock('../stores/locationStore', () => ({ useLocationStore: { getState: () => fx.place } }));
vi.mock('../lib/deviceLocation', () => ({
  grantedLocationFix: (latitude: number | null, longitude: number | null, status: string) =>
    (status === 'granted' && latitude != null && longitude != null ? { latitude, longitude } : null),
}));

import { customerKeys, prefetchActiveRide, prefetchOrder, prefetchVendor, useCart, useOrder } from './customer';
import { PRESS_READ_DELAY_MS, usePressRead, useVendorPrefetch } from './storeDoor';

const CART = { id: 'cart', items: [{ id: 'line', itemId: 'item', quantity: 1 }], totalAmount: 2500 };
const answer = (data: unknown) => ({ data: { data } });
const later = () => {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };

/** Renders `use()` in a probe and hands back its latest result. */
async function probe<T>(use: () => T): Promise<{ current: () => T; rerender: () => Promise<void> }> {
  let latest!: T;
  function Probe() { latest = use(); return null; }
  const draw = async () => act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))));
  await draw();
  return { current: () => latest, rerender: draw };
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.place = { latitude: 6.8, longitude: -58.16, status: 'granted' };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.clear();
});

describe('[APP-SPEED A] the Cart tab’s first quote', () => {
  it('stands in with the store page’s quote of the same cart, flagged, until its own quote replaces it', async () => {
    client.setQueryData(customerKeys.cart(), CART);
    const read = later();
    fx.getCart.mockImplementationOnce(() => read.promise);
    const cart = await probe(() => useCart<any>(6.8, -58.16, { tipAmount: 0 }, true, true));

    expect(cart.current().data).toEqual(CART);
    expect(cart.current().isPlaceholderData, 'flagged: the screen holds Place order').toBe(true);

    const fresh = { ...CART, totalAmount: 2700 };
    read.resolve(answer(fresh));
    await flush();
    expect(cart.current().isPlaceholderData).toBe(false);
    expect(cart.current().data).toEqual(fresh);
  });

  it('never an empty cart, never a quote waiting on its own re-read, and never for the store page or the cart bar', async () => {
    fx.getCart.mockImplementation(() => new Promise(() => {}));
    client.setQueryData(customerKeys.cart(), null);
    const empty = await probe(() => useCart<any>(6.8, -58.16, { tipAmount: 0 }, true, true));
    expect(empty.current().data).toBeUndefined();

    client.setQueryData(customerKeys.cart(), CART);
    await client.invalidateQueries({ queryKey: customerKeys.cart(), exact: true, refetchType: 'none' });
    const waiting = await probe(() => useCart<any>(1, 2, { tipAmount: 0 }, true, true));
    expect(waiting.current().data).toBeUndefined();

    client.clear();
    client.setQueryData(customerKeys.cart(9, 9, {}), CART);
    const storePage = await probe(() => useCart<any>());
    expect(storePage.current().data, 'the store page keeps its own first read').toBeUndefined();
  });
});

describe('[APP-SPEED A] the promo code is not part of the quote’s key (it is never sent with the read)', () => {
  it('the same quote with and without the applied code is one key', () => {
    expect(customerKeys.cart(1, 2, { tipAmount: 0, promoCode: 'SAVE10' })).toEqual(customerKeys.cart(1, 2, { tipAmount: 0 }));
    expect(customerKeys.cart(1, 2, { express: true, promoCode: 'SAVE10' })).not.toEqual(customerKeys.cart(1, 2, { tipAmount: 0 }));
    expect(customerKeys.cart()).toEqual(['customer', 'cart', null, null, null]);
  });

  it('a code arriving in the choices (the quote’s own echo) asks no second quote', async () => {
    fx.getCart.mockResolvedValue(answer(CART));
    let choices: { tipAmount: number; promoCode?: string } = { tipAmount: 0 };
    const cart = await probe(() => useCart<any>(6.8, -58.16, choices, true, true));
    await flush();
    expect(fx.getCart).toHaveBeenCalledTimes(1);
    choices = { tipAmount: 0, promoCode: 'SAVE10' };
    await cart.rerender();
    await flush();
    expect(fx.getCart, 'one quote: the echo of the stored code is not a new question').toHaveBeenCalledTimes(1);
    expect(cart.current().isPlaceholderData).toBe(false);
  });
});

describe('[APP-SPEED A] an order’s list row stands in only where the screen asked', () => {
  it('useOrder without `preview` (Feedback, the rating screen) never draws a list row', async () => {
    client.setQueryData(['customer', 'orders', 'live'], { items: [{ id: 'order-1', orderNumber: 'SW-1' }], total: 1 });
    fx.getOrder.mockImplementation(() => new Promise(() => {}));
    const plain = await probe(() => useOrder<any>('order-1'));
    expect(plain.current().data).toBeUndefined();
    const asked = await probe(() => useOrder<any>('order-1', undefined, { preview: true }));
    expect(asked.current().data).toEqual({ id: 'order-1', orderNumber: 'SW-1' });
    expect(asked.current().isPlaceholderData).toBe(true);
  });
});

describe('[APP-SPEED A] reads asked at the finger-down', () => {
  it('a store’s menu: with the customer’s granted place, only when nothing is in memory or on its way', async () => {
    const read = later();
    fx.getVendor.mockImplementationOnce(() => read.promise);
    prefetchVendor(client, 'store-1', { lat: 6.8, lng: -58.16 });
    prefetchVendor(client, 'store-1', { lat: 6.8, lng: -58.16 });
    expect(fx.getVendor).toHaveBeenCalledTimes(1);
    expect(fx.getVendor).toHaveBeenCalledWith('store-1', { lat: 6.8, lng: -58.16 });
    read.resolve(answer({ id: 'store-1', name: 'Store 1' }));
    await flush();
    expect(client.getQueryData(customerKeys.vendor('store-1'))).toEqual({ id: 'store-1', name: 'Store 1' });
    expect(prefetchVendor(client, 'store-1', null), 'a remembered store is re-read by its page, not here').toBeUndefined();
    expect(fx.getVendor).toHaveBeenCalledTimes(1);
  });

  it('an order, and "is a ride in progress?": only when nothing is in memory or on its way', async () => {
    fx.getOrder.mockImplementation(() => new Promise(() => {}));
    fx.active.mockImplementation(() => new Promise(() => {}));
    prefetchOrder(client, 'order-1');
    prefetchOrder(client, 'order-1');
    expect(fx.getOrder).toHaveBeenCalledTimes(1);
    client.setQueryData(customerKeys.order('order-2'), { id: 'order-2' });
    prefetchOrder(client, 'order-2');
    expect(fx.getOrder).toHaveBeenCalledTimes(1);

    prefetchActiveRide(client);
    prefetchActiveRide(client);
    expect(fx.active).toHaveBeenCalledTimes(1);
    client.clear();
    client.setQueryData(['rides', 'active'], null);
    prefetchActiveRide(client);
    expect(fx.active, 'a remembered "no ride" is re-read by the Taxi screen itself').toHaveBeenCalledTimes(1);
  });
});

describe('[APP-SPEED A · review S2-1] a cart change before the Cart tab is first shown', () => {
  it('re-reads only the store page’s cart key; the hidden Cart tab’s held quote asks nothing', async () => {
    fx.getCart.mockImplementation(() => Promise.resolve(answer(CART)));
    const both = await probe(() => [useCart<any>(), useCart<any>(6.8, -58.16, { tipAmount: 0 }, false, true)] as const);
    await flush();
    expect(fx.getCart).toHaveBeenCalledTimes(1);
    expect(both.current()[1].data, 'the hidden tab may draw the store page’s quote').toEqual(CART);

    // What every cart mutation does when it lands (hooks/customer invalidateCart).
    await act(async () => { await client.invalidateQueries({ queryKey: ['customer', 'cart'] }); });
    await flush();
    expect(fx.getCart).toHaveBeenCalledTimes(2);
    for (const call of fx.getCart.mock.calls) expect(call, 'only the store page’s key (no place, no choices)').toEqual([undefined, undefined, undefined]);
  });
});

describe('[APP-SPEED A · review S3] an empty cart of this quote is kept, never replaced by another cart', () => {
  it('a choice change on an empty cart keeps "empty" as its stand-in', async () => {
    client.setQueryData(customerKeys.cart(), CART);
    fx.getCart.mockImplementationOnce(() => Promise.resolve(answer(null))).mockImplementation(() => new Promise(() => {}));
    let choices: Record<string, unknown> = { tipAmount: 0 };
    const cart = await probe(() => useCart<any>(6.8, -58.16, choices as never, true, true));
    await flush();
    expect(cart.current().data).toBeNull();
    choices = { express: true };
    await cart.rerender();
    expect(cart.current().isPlaceholderData).toBe(true);
    expect(cart.current().data, 'this quote’s own empty cart, not the store page’s').toBeNull();
  });
});

describe('[APP-SPEED A · review S2-2] reads asked by a resting finger', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('a press that ends inside the delay (a lift or a scroll starting on the card) reads nothing', async () => {
    const read = vi.fn(() => Promise.resolve());
    const press = await probe(() => usePressRead());
    const handlers = press.current()(read);
    handlers.onPressIn();
    await act(async () => { await vi.advanceTimersByTimeAsync(PRESS_READ_DELAY_MS - 20); });
    handlers.onPressOut();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(read).not.toHaveBeenCalled();
  });

  it('a finger resting on the card starts the read once; one read in flight at a time', async () => {
    let land!: () => void;
    const first = vi.fn(() => new Promise<void>((res) => { land = res; }));
    const second = vi.fn(() => Promise.resolve());
    const press = await probe(() => usePressRead());
    press.current()(first).onPressIn();
    await act(async () => { await vi.advanceTimersByTimeAsync(PRESS_READ_DELAY_MS + 5); });
    expect(first).toHaveBeenCalledTimes(1);

    press.current()(second).onPressIn();
    await act(async () => { await vi.advanceTimersByTimeAsync(PRESS_READ_DELAY_MS + 5); });
    expect(second, 'another card waits while the first read is on its way').not.toHaveBeenCalled();

    await act(async () => { land(); await vi.advanceTimersByTimeAsync(1); });
    press.current()(second).onPressIn();
    await act(async () => { await vi.advanceTimersByTimeAsync(PRESS_READ_DELAY_MS + 5); });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('the store card’s handlers ask the menu with the granted place, only after the delay', async () => {
    fx.getVendor.mockImplementation(() => Promise.resolve(answer({ id: 'store-9' })));
    const store = await probe(() => useVendorPrefetch());
    const handlers = store.current()('store-9');
    handlers.onPressIn();
    expect(fx.getVendor).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(PRESS_READ_DELAY_MS + 5); });
    expect(fx.getVendor).toHaveBeenCalledWith('store-9', { lat: 6.8, lng: -58.16 });
    handlers.onPressOut();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  });
});

