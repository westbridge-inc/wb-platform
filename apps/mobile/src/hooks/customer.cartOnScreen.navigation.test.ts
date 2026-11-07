/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED C] The Cart tab's quote while another screen is in front (a store page's + and −). The Cart tab is never
// frozen and, once opened, stays mounted: every cart write's invalidation used to re-quote it behind the store page
// (one more request per tap, and a redraw of the hidden cart). Now it is watched only while on screen (`onScreen`):
// a cart write marks it stale; shown again, it is read once, and its read is on its way at the first draw, so the
// cart's Place order (quoteSettled: !isFetching) is held until it lands. The REAL hooks over a real query client.
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

import { useCart } from './customer';

const CART = { id: 'cart', items: [{ id: 'line', itemId: 'item', quantity: 1 }], totalAmount: 2500 };
const answer = (data: unknown) => ({ data: { data } });

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };
const TAB = [6.8, -58.16, { tipAmount: 0 }] as const;
const tabReads = () => fx.getCart.mock.calls.filter((call) => call[0] === 6.8).length;
const storeReads = () => fx.getCart.mock.calls.filter((call) => call[0] === undefined).length;
/** What every cart write does when it lands (hooks/customer invalidateCart). */
const cartWrite = async () => { await act(async () => { await client.invalidateQueries({ queryKey: ['customer', 'cart'] }); }); await flush(); };

let onScreen = false;
let draws: Array<{ isFetching: boolean; data: unknown }> = [];
function StorePage() { useCart<any>(); return null; }
function CartTab() {
  const q = useCart<any>(TAB[0], TAB[1], TAB[2], true, true, onScreen);
  draws.push({ isFetching: q.isFetching, data: q.data });
  return null;
}
const draw = async () => act(async () => root.render(
  React.createElement(QueryClientProvider, { client }, React.createElement(StorePage), React.createElement(CartTab)),
));

beforeEach(() => {
  vi.clearAllMocks();
  fx.getCart.mockImplementation((lat?: number) => Promise.resolve(answer(lat === undefined ? CART : { ...CART, totalAmount: 2700 })));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  draws = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.clear();
});

describe('[APP-SPEED C] the opened Cart tab while a store page is in front', () => {
  it('a cart write re-reads the store page only; the hidden tab is neither re-quoted nor redrawn', async () => {
    onScreen = true;
    await draw();
    await flush();
    expect(tabReads()).toBe(1);
    onScreen = false; // the customer went back to the store page
    await draw();
    await flush();
    const before = { tab: tabReads(), store: storeReads(), draws: draws.length };

    await cartWrite();
    await cartWrite();
    expect(storeReads(), 'the store page on screen reads the cart after each write').toBe(before.store + 2);
    expect(tabReads(), 'the hidden Cart tab asks nothing').toBe(before.tab);
    expect(draws.length, 'and is not redrawn by the store page’s answers').toBe(before.draws);
  });

  it('shown again: read once, and its read is on its way at the first draw (Place order held until it lands)', async () => {
    onScreen = true;
    await draw();
    await flush();
    onScreen = false;
    await draw();
    await cartWrite();
    const reads = tabReads();
    // The re-show's read answers only when the test says, with a new total: every draw until then is pinned, not
    // just the last one (the old assertion read the LAST draw, which raced the answer landing a macrotask later).
    let land!: (v: unknown) => void;
    fx.getCart.mockImplementationOnce(() => new Promise((r) => { land = r; }));

    onScreen = true;
    const shown = draws.length;
    await draw();
    await flush();
    const waiting = draws.slice(shown);
    expect(waiting.length, 'drawn on screen').toBeGreaterThan(0);
    expect(waiting[0]!.isFetching, 'the first draw on screen holds Order (quoteSettled needs !isFetching)').toBe(true);
    expect(waiting.every((d) => d.isFetching), 'Order stays held on every draw until the fresh quote lands').toBe(true);
    expect(waiting.map((d) => (d.data as { totalAmount: number }).totalAmount), 'the last quote shows meanwhile').not.toContain(2900);
    expect(tabReads(), 'exactly one read of the stale quote').toBe(reads + 1);

    await act(async () => { land(answer({ ...CART, totalAmount: 2900 })); });
    await flush();
    expect(draws.at(-1)!.isFetching).toBe(false);
    expect((draws.at(-1)!.data as { totalAmount: number }).totalAmount).toBe(2900);
    expect(tabReads(), 'still one read').toBe(reads + 1);
  });

  it('control: on screen, a cart write re-quotes the tab as before', async () => {
    onScreen = true;
    await draw();
    await flush();
    const reads = tabReads();
    await cartWrite();
    expect(tabReads()).toBe(reads + 1);
  });
});
