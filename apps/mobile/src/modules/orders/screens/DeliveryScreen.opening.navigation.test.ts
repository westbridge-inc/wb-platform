/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED A · owner 7 Nov: "tapping and lagginess"] "Track order" opened a
// blank spinner although the list it was tapped from held the order. Now the
// order's row from the lists already in memory is drawn AT ONCE, its status
// said as "checking", and not one action (Cancel, the MMG claim, a swap, a
// refund answer) until the server's own read replaces it.
//
// The REAL order screen over the REAL order hooks and a real query client
// (the setup of DeliveryScreen.cancelRead); the transport, the socket, native
// drawing and the toast are stand-ins.
// ---------------------------------------------------------------------------

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const deferred = (): Deferred => {
  let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const fx = vi.hoisted(() => ({
  getOrder: vi.fn(),
  cancelOrder: vi.fn(),
  handlers: new Map<string, (payload?: unknown) => void>(),
  toastError: vi.fn(),
  toastShow: vi.fn(),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Pressable, Text: View, ScrollView: View,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Platform: { OS: 'android' },
    Linking: { openURL: vi.fn(async () => true) },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Share: { share: vi.fn() },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('div', { 'data-map': '' }, p.children), Marker: () => null };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn(), canGoBack: () => true }),
  useRoute: () => ({ params: { orderId: 'order-1' } }),
}));
vi.mock('../../../components/MapCredits', () => ({ MapCredits: () => null }));
vi.mock('../../safety/SosCeremony', () => ({ SosCeremony: () => null }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: null, longitude: null, status: 'denied' }) }));
vi.mock('../../../lib/deviceLocation', () => ({ grantedLocationFix: () => null }));
// The REAL hooks/customer runs; these are its own dependencies.
vi.mock('../../../services/api', () => ({
  API_URL: 'https://api.test', WEB_URL: 'https://web.test',
  customerApi: { getOrder: fx.getOrder, cancelOrder: fx.cancelOrder },
  courierApi: {}, marketApi: {}, discoveryApi: {}, moderationApi: {}, rideApi: {},
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../../../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn(), checkoutFailureOutcome: vi.fn(), settleUnresolvedIntent: vi.fn() }));
vi.mock('../../../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, sessionGeneration: 1, user: { id: 'customer-1' } };
  return {
    useAuthStore: Object.assign((select?: (s: typeof state) => unknown) => (select ? select(state) : state), { getState: () => state }),
    getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: vi.fn(), AuthSessionBoundaryError: class extends Error {},
  };
});
vi.mock('../../../services/socket', () => ({
  connectSocket: vi.fn(), subscribeToOrder: vi.fn(),
  getSocket: () => ({
    connected: true,
    on: (event: string, fn: (payload?: unknown) => void) => { fx.handlers.set(event, fn); },
    off: (event: string) => { fx.handlers.delete(event); },
    emit: vi.fn(),
  }),
}));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), failure: vi.fn(), commit: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../lib/payLink', () => ({ openMmgPaymentAction: vi.fn(), safeMmgPaymentActionUrl: () => false }));
vi.mock('../../../kit/toast', () => ({ toast: { show: fx.toastShow, error: fx.toastError, success: vi.fn() } }));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));
vi.mock('../../../kit/vertical-tint', () => ({ VERTICAL_TINT: {} }));
vi.mock('../MmgPaymentClaimCard', () => ({ MmgPaymentClaimCard: () => null }));
vi.mock('../CustodyRecoveryNotice', () => ({ CustodyRecoveryNotice: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const Box = (p: any) => h('div', a11y(p), p.children);
  const T = (p: any) => h('span', a11y(p), p.children);
  return {
    T, Eyebrow: T, PopupTitle: T, DecorativeIcon: Box, IconChip: () => null, CircleChip: Box,
    InfoRow: (p: any) => h('div', null, p.label, p.value),
    Timeline: () => null, HoldRing: () => null, LoadingBlock: () => h('div', null, 'Loading'), ErrorState: () => h('div', null, 'Error'),
    // The kit header (its Back chip) on the loading and failure branches [UI-SWEEP U32].
    Header: () => h('div', { 'aria-label': 'Back' }),
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, disabled: !!(p.disabled || p.loading), onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    holdRingCaption: () => '', holdRingWindow: () => null,
  };
});

import { DeliveryScreen } from './DeliveryScreen';

const ORDER = {
  id: 'order-1', orderNumber: 'SW-1001', orderType: 'FOOD_DELIVERY', status: 'PENDING', fulfillment: 'DELIVERY',
  vendor: { id: 'store-1', name: 'Test store' }, items: [], placedAt: '2026-10-16T12:00:00.000Z',
  paymentMethod: 'CASH', paymentStatus: 'PENDING', canCancel: true, totalAmount: 2500, subtotal: 2500,
  cancellationMessage: 'Cancelling now is free.',
};
const answer = (data: unknown) => ({ data: { data } });
/** The row the Orders screen's live list holds: the list projection, not the order. */
const LIST_ROW = { id: 'order-1', orderNumber: 'SW-1001', orderType: 'FOOD_DELIVERY', status: 'PENDING', vendor: { id: 'store-1', name: 'Test store' } };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
async function open() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(DeliveryScreen))));
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.handlers.clear();
  fx.getOrder.mockReset(); fx.cancelOrder.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.clear();
});

describe('[APP-SPEED A] Track order opens on the row the phone already has', () => {
  it('draws the store and order number at once, says "checking", and offers no action until the server answers', async () => {
    client.setQueryData(['customer', 'orders', 'live'], { items: [LIST_ROW], total: 1 });
    const read = deferred();
    fx.getOrder.mockImplementationOnce(() => read.promise);

    await open();

    // (a) instantly, from the list
    expect(host.textContent).toContain('Test store');
    expect(host.textContent).toContain('Order SW-1001');
    expect(host.textContent).toContain('Checking the latest status…');
    // (b) nothing that changes the order: no Cancel, no MMG claim, no swap, no refund answer
    expect(buttons(), 'not one button while the row stands in').toEqual([]);
    expect(host.textContent).not.toContain('Cancel order');

    // (c) the server's own order replaces it
    read.resolve(answer(ORDER));
    await flush();
    expect(host.textContent).not.toContain('Checking the latest status…');
    expect(buttons()).toContain('Cancel order');
  });

  it('Home’s live-order card and the history pages are rows too; the newest copy wins', async () => {
    const now = Date.now();
    client.setQueryData(['customer', 'orders', 'infinite', 'history'], { pages: [{ items: [{ ...LIST_ROW, vendor: { id: 'store-1', name: 'History name' } }] }], pageParams: [1] }, { updatedAt: now - 60_000 });
    client.setQueryData(['customer', 'home', null, null], { activeOrder: { ...LIST_ROW, vendor: { id: 'store-1', name: 'Home card name' } } }, { updatedAt: now });
    fx.getOrder.mockImplementationOnce(() => deferred().promise);
    await open();
    expect(host.textContent).toContain('Home card name');
    expect(host.textContent).not.toContain('History name');
    expect(buttons()).toEqual([]);
  });

  it('a failed first read never shows the row as the order', async () => {
    client.setQueryData(['customer', 'orders', 'live'], { items: [LIST_ROW], total: 1 });
    const read = deferred();
    fx.getOrder.mockImplementationOnce(() => read.promise);
    await open();
    expect(host.textContent).toContain('Test store');

    read.reject(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }));
    await flush();
    expect(host.textContent).toContain('Error');
    expect(host.textContent).not.toContain('Test store');
    expect(host.textContent).not.toContain('Checking the latest status…');
  });

  it('a list waiting on its own re-read (invalidated) is not used: plain loading, as before', async () => {
    client.setQueryData(['customer', 'orders', 'live'], { items: [LIST_ROW], total: 1 });
    await client.invalidateQueries({ queryKey: ['customer', 'orders'], refetchType: 'none' });
    fx.getOrder.mockImplementationOnce(() => deferred().promise);
    await open();
    expect(host.textContent).toContain('Loading');
    expect(host.textContent).not.toContain('Test store');
  });

  it('a ride’s row draws nothing of a store order while the hand-off waits for the answer', async () => {
    client.setQueryData(['customer', 'orders', 'live'], { items: [{ ...LIST_ROW, orderType: 'TAXI', vertical: 'TAXI' }], total: 1 });
    fx.getOrder.mockImplementationOnce(() => deferred().promise);
    await open();
    expect(host.textContent).toContain('Loading');
    expect(host.textContent).not.toContain('Test store');
    expect(host.textContent).not.toContain('Checking the latest status…');
  });
});

describe('[APP-SPEED A · review S3] offline: never "Checking…" forever', () => {
  afterEach(() => { onlineManager.setOnline(true); });

  it('the first read parked offline with only the row: the error state says offline, with Try again', async () => {
    onlineManager.setOnline(false);
    client.setQueryData(['customer', 'orders', 'live'], { items: [LIST_ROW], total: 1 });
    fx.getOrder.mockImplementation(() => Promise.resolve(answer(ORDER)));
    await open();
    await flush();
    expect(client.getQueryState(['customer', 'order', 'order-1'])?.fetchStatus).toBe('paused');
    expect(host.textContent).toContain('Error');
    expect(host.textContent).not.toContain('Checking the latest status…');
    expect(buttons()).toEqual([]);

    onlineManager.setOnline(true);
    await flush();
    expect(host.textContent).not.toContain('Error');
    expect(buttons()).toContain('Cancel order');
  });
});
