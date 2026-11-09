/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [owner 8 Nov 2026] "When the store says out of stock and rejects it, it should tell the customer that it was
// rejected because of out of stock, not just that it cancels." The test order SW-261108-003K2E sat in "Your activity"
// as "Cancelled · 11:22 AM". A cancelled row now says who closed it and why, from the server's `cancellation`
// ("Declined by store · Out of stock"); each other way an order closes keeps distinct words; an older server's row
// (no `cancellation`) keeps "Cancelled". The REAL screen over the REAL order hooks (the harness of
// OrdersHistoryScreen.firstPage.navigation.test.ts); only the transport and native drawing are stand-ins.
// ---------------------------------------------------------------------------

type Row = { id: string; status: string; orderType: string; orderNumber: string; placedAt: string; totalAmount: number; vendor: { name: string; logoUrl?: string | null; coverImageUrl?: string | null }; fulfillment?: string; paymentMethod?: string; cancellation?: unknown };
const fx = vi.hoisted(() => ({
  goBack: vi.fn(),
  live: [] as Row[],
  history: [] as Row[],
  calls: { live: 0, history: 0 },
  pages: [] as number[],
  failHistory: false,
  /** Each history read takes this long (ms of the test's time). */
  slowMs: 0,
  pull: null as null | (() => void),
  endReached: null as null | (() => void),
  focused: true,
  appState: { current: 'active' as string, listeners: new Set<(s: string) => void>() },
}));
const order = (id: string, status: string): Row => ({
  id, status, orderType: 'FOOD_DELIVERY', orderNumber: id.toUpperCase(), placedAt: '2026-10-16T12:00:00.000Z', totalAmount: 2500, vendor: { name: `Store ${id}` },
});

vi.mock('react-native', async () => {
  const { createElement: h, Fragment } = await import('react');
  const kids = (p: any) => (typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  const el = (c: any) => (c == null ? null : React.isValidElement(c) ? c : h(c));
  return {
    View: (p: any) => h('div', null, kids(p)),
    Pressable: (p: any) => h('button', { onClick: p.onPress, 'aria-label': p.accessibilityLabel }, kids(p)),
    RefreshControl: (p: any) => { fx.pull = p.onRefresh; return null; },
    FlatList: (p: any) => (fx.endReached = p.onEndReached, h('div', null, el(p.refreshControl), el(p.ListHeaderComponent),
      (p.data ?? []).map((item: any, index: number) => h(Fragment, { key: p.keyExtractor(item, index) }, p.renderItem({ item, index }))),
      el(p.ListFooterComponent))),
    AppState: {
      get currentState() { return fx.appState.current; },
      addEventListener: (_: string, fn: (s: string) => void) => { fx.appState.listeners.add(fn); return { remove: () => fx.appState.listeners.delete(fn) }; },
    },
    Platform: { OS: 'android' },
  };
});
vi.mock('react-native-reanimated', async () => {
  const { createElement: h } = await import('react');
  const chain: any = { duration: () => chain, delay: () => chain, reduceMotion: () => chain };
  return { __esModule: true, default: { View: (p: any) => h('div', null, p.children) }, FadeInDown: chain, ReduceMotion: { System: 'system' } };
});
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn(), goBack: fx.goBack }), useIsFocused: () => fx.focused }));
vi.mock('../../../services/api', () => ({
  API_URL: 'https://api.test',
  customerApi: {
    getOrders: vi.fn(async (page: number, opts: { live?: boolean }) => {
      if (opts?.live) { fx.calls.live += 1; return { data: { data: fx.live, meta: { page: 1, totalPages: 1, total: fx.live.length } } }; }
      fx.calls.history += 1;
      fx.pages.push(page);
      if (fx.slowMs) await new Promise((r) => setTimeout(r, fx.slowMs));
      if (fx.failHistory) throw new Error('offline');
      const per = 20;
      const rows = fx.history.slice((page - 1) * per, page * per);
      return { data: { data: rows, meta: { page, totalPages: Math.ceil(fx.history.length / per), total: fx.history.length } } };
    }),
  },
  marketApi: {}, discoveryApi: {}, moderationApi: {},
}));
vi.mock('../../../services/socket', () => ({ getSocket: () => ({ connected: false }) }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../../../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn(), checkoutFailureOutcome: vi.fn(), settleUnresolvedIntent: vi.fn() }));
vi.mock('../../../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, promptLogin: () => {}, sessionGeneration: 1, user: { id: 'customer-1' } };
  return {
    useAuthStore: Object.assign((select?: (s: typeof state) => unknown) => (select ? select(state) : state), { getState: () => state }),
    getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: vi.fn(), AuthSessionBoundaryError: class extends Error {},
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
// The real photo choice (lib/images vendorPhoto): the U-P3 tile reads it.
vi.mock('../../../lib/images', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../lib/images')>()) }));
vi.mock('../../../kit/controls', async () => {
  const { createElement: h } = await import('react');
  return { TonePill: (p: any) => h('span', { 'data-status': '' }, p.label) };
});
vi.mock('../../../kit', async () => {
  const { createElement: h } = await import('react');
  const { useNavigation } = await import('@react-navigation/native');
  const Box = (p: any) => h('div', null, p.children);
  return {
    Screen: Box, T: (p: any) => h('span', null, p.children),
    // The kit Header every pushed screen uses (kit/screen.tsx): Back, top left, goBack by default.
    Header: (p: any) => {
      const nav = useNavigation<any>();
      return h('header', { 'data-kit-header': '' }, h('button', { 'aria-label': 'Back', onClick: p.onBack ?? (() => nav.goBack()) }), p.title ?? null);
    },
    // The store tile: what it would draw, so a test can read it (kit/photo-placeholder.tsx Photo).
    Photo: (p: any) => h('figure', { 'data-uri': p.uri ?? '', 'data-show-label': String(p.showLabel ?? true), 'data-label': p.label ?? '' }),
    Pictogram: () => null, Money: (p: any) => h('span', null, p.amount),
    PillButton: (p: any) => h('button', { onClick: p.onPress }, p.label),
    CircleChip: (p: any) => h('button', { 'aria-label': p.label, onClick: p.onPress }),
    EmptyState: (p: any) => h('section', null, p.title), ErrorState: () => h('div', null, 'Error'), LoadingBlock: () => h('div', null, 'Loading'),
  };
});

import { OrdersHistoryScreen } from './OrdersHistoryScreen';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let client: QueryClient;
const settle = async (ms = 0) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  for (let i = 0; i < 3; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
};
async function render() {
  await act(async () => root!.render(React.createElement(QueryClientProvider, { client }, React.createElement(OrdersHistoryScreen))));
  await settle();
}
/** The meta line of each history row ("<status> · <time>"), by store name. */
const metaOf = (storeName: string): string => {
  const figure = [...host.querySelectorAll('figure')].find((f) => f.getAttribute('data-label') === storeName);
  expect(figure, storeName).toBeTruthy();
  return figure!.parentElement!.querySelector('span')!.textContent ?? '';
};
const cancelled = (id: string, cancellation: unknown, extra: Partial<Row> = {}): Row => ({ ...order(id, 'CANCELLED'), cancellation, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  fx.live = []; fx.history = []; fx.calls = { live: 0, history: 0 }; fx.pages = []; fx.failHistory = false; fx.slowMs = 0; fx.pull = null; fx.endReached = null; fx.focused = true;
  fx.appState.current = 'active'; fx.appState.listeners.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined; client.clear();
  vi.useRealTimers();
});

describe('[owner 8 Nov 2026] a cancelled row in "Your activity" says who closed it and why', () => {
  it('RED reproduction — the store declined it as out of stock: "Declined by store · Out of stock", never a bare "Cancelled"', async () => {
    fx.history = [cancelled('sw3k2e', { by: 'STORE', reason: 'Out of stock' })];
    await render();
    expect(metaOf('Store sw3k2e')).toMatch(/^Declined by store · Out of stock · /);
  });

  it('each other way an order closes has its own words', async () => {
    fx.history = [
      cancelled('booking', { by: 'STORE', reason: 'Fully booked at that time' }, { fulfillment: 'APPOINTMENT' }),
      cancelled('silent', { by: 'NO_RESPONSE', reason: null }),
      cancelled('mine', { by: 'CUSTOMER', reason: null }),
      cancelled('support', { by: 'SWIFT', reason: null }),
      cancelled('uncollected', { by: 'NO_SHOW', reason: null }, { fulfillment: 'PICKUP' }),
      cancelled('cold', { by: 'SYSTEM', reason: 'FOOD_TOO_OLD' }),
      cancelled('nodetail', { by: 'STORE', reason: null }),
    ];
    await render();
    expect(metaOf('Store booking')).toMatch(/^Declined by provider · Fully booked at that time · /);
    expect(metaOf('Store silent')).toMatch(/^Store didn’t respond · /);
    expect(metaOf('Store mine')).toMatch(/^Cancelled by you · /);
    expect(metaOf('Store support')).toMatch(/^Cancelled by Swift · /);
    expect(metaOf('Store uncollected')).toMatch(/^Not collected · /);
    expect(metaOf('Store cold')).toMatch(/^No rider found · /);
    expect(metaOf('Store nodetail')).toMatch(/^Declined by store · \d/);
  });

  it('an older server (no `cancellation`), a malformed one, and a delivered row keep their words', async () => {
    fx.history = [
      order('old', 'CANCELLED'),
      cancelled('odd', { by: 'SOMEONE_NEW', reason: 'x' }),
      order('done', 'DELIVERED'),
    ];
    await render();
    expect(metaOf('Store old')).toMatch(/^Cancelled · /);
    expect(metaOf('Store odd')).toMatch(/^Cancelled · /);
    expect(metaOf('Store done')).not.toMatch(/Cancelled|Declined/);
  });

  it('no render loop: one read of each list on the first draw, and nothing more while it sits on screen', async () => {
    fx.history = [cancelled('sw3k2e', { by: 'STORE', reason: 'Out of stock' })];
    await render();
    const first = { ...fx.calls };
    await settle(5_000);
    expect(fx.calls.history).toBe(first.history);
    expect(first.history).toBeLessThanOrEqual(2);
  });
});
