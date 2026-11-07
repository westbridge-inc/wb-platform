/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED C · report item 12] "Your activity" pages its history twenty orders at a time. A refresh (back to the
// screen, back from the background, a live order leaving, the pull, Try again) used to re-read EVERY page the
// customer had scrolled through, one after the other: five pages, five round trips (~0.3 s each from Guyana), for
// rows that are history. Now a refresh re-reads page 1 only and the list continues from there (lib/infiniteFirstPage).
// The REAL screen over the REAL order hooks and a real query client; only the transport (customerApi.getOrders),
// native drawing and the OS app state are stand-ins (the harness of OrdersHistoryScreen.live.navigation.test.ts).
// ---------------------------------------------------------------------------

type Row = { id: string; status: string; orderType: string; orderNumber: string; placedAt: string; totalAmount: number; vendor: { name: string; logoUrl?: string | null; coverImageUrl?: string | null } };
const fx = vi.hoisted(() => ({
  goBack: vi.fn(),
  live: [] as Row[],
  history: [] as Row[],
  calls: { live: 0, history: 0 },
  pages: [] as number[],
  failHistory: false,
  pull: null as null | (() => void),
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
    FlatList: (p: any) => h('div', null, el(p.refreshControl), el(p.ListHeaderComponent),
      (p.data ?? []).map((item: any, index: number) => h(Fragment, { key: p.keyExtractor(item, index) }, p.renderItem({ item, index }))),
      el(p.ListFooterComponent)),
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
async function appGoes(state: string) {
  fx.appState.current = state;
  await act(async () => { for (const fn of [...fx.appState.listeners]) fn(state); });
  await settle();
}
const shown = () => [...host.querySelectorAll('figure')].map((t) => t.getAttribute('data-label'));
async function showMore() {
  const more = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Show more'));
  expect(more, 'Show more').toBeTruthy();
  await act(async () => more!.click());
  await settle();
}
/** Three pages scrolled through: 60 of 70 orders on screen. */
async function scrolledThreePages() {
  fx.history = Array.from({ length: 70 }, (_, i) => order(`h${i + 1}`, 'DELIVERED'));
  await render();
  await showMore();
  await showMore();
  expect(shown()).toHaveLength(60);
  fx.pages = [];
}

beforeEach(() => {
  vi.useFakeTimers();
  fx.live = []; fx.history = []; fx.calls = { live: 0, history: 0 }; fx.pages = []; fx.failHistory = false; fx.pull = null; fx.focused = true;
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

describe('[APP-SPEED C] a history refresh reads page 1, never every page scrolled through', () => {
  it('back from the background: one request (page 1), and the list continues from it', async () => {
    await scrolledThreePages();
    await appGoes('background');
    await appGoes('active');
    expect(fx.pages, 'page 1 only, not pages 1, 2 and 3').toEqual([1]);
    expect(shown()).toHaveLength(20);
    expect(shown()[0]).toBe('Store h1');
    // Scrolling on reads the next page from the fresh first page.
    await showMore();
    expect(fx.pages).toEqual([1, 2]);
    expect(shown()).toHaveLength(40);
  });

  it('the pull: page 1 only', async () => {
    await scrolledThreePages();
    expect(fx.pull).toBeTypeOf('function');
    await act(async () => { fx.pull!(); });
    await settle();
    expect(fx.pages).toEqual([1]);
    expect(shown()).toHaveLength(20);
  });

  it('a new order at the top: the refreshed first page has it, and no row is lost or drawn twice further down', async () => {
    await scrolledThreePages();
    fx.history = [order('new', 'DELIVERED'), ...fx.history];
    await appGoes('background');
    await appGoes('active');
    await showMore();
    await showMore();
    await showMore();
    const labels = shown();
    expect(labels[0]).toBe('Store new');
    expect(labels).toHaveLength(71);
    expect(new Set(labels).size, 'never drawn twice').toBe(71);
  });

  it('a failed refresh keeps the rows on screen (never an empty list, never the error screen)', async () => {
    await scrolledThreePages();
    fx.failHistory = true;
    await act(async () => { fx.pull!(); });
    await settle();
    expect(fx.pages).toEqual([1]);
    expect(shown().length).toBeGreaterThan(0);
    expect(host.textContent).not.toContain('No activity yet');
    expect(host.textContent).not.toContain('Error');
    expect(host.textContent, 'the failure is said, with a retry').toContain('Couldn’t refresh your history. Tap to retry.');
    fx.failHistory = false;
    await act(async () => (host.querySelector('button[aria-label="Retry refreshing your history"]') as HTMLButtonElement).click());
    await settle();
    expect(host.textContent).not.toContain('Couldn’t refresh your history');
    expect(shown()).toHaveLength(20);
  });
});
