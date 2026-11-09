/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [owner 8 Nov 2026] "When the store says out of stock and rejects it, it should tell the customer that it was
// rejected because of out of stock, not just that it cancels." The order screen of SW-261108-003K2E said only
// "This order was cancelled." It now reads the server's `cancellation`: "The store declined your order: Out of
// stock.", what is true about the money for this payment method, and one tap to another store of the same kind.
// The customer on this screen when the store declines sees it at once (the socket's status event re-reads the order).
// The REAL order screen over the REAL order hooks (the harness of DeliveryScreen.mmgStoreNumber.navigation.test.ts).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  getOrder: vi.fn(),
  cancelOrder: vi.fn(),
  handlers: new Map<string, (payload?: unknown) => void>(),
  toastError: vi.fn(),
  toastShow: vi.fn(),
  copied: [] as string[],
  navigate: vi.fn(),
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
  useNavigation: () => ({ navigate: fx.navigate, goBack: vi.fn(), canGoBack: () => true }),
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
  courierApi: {}, marketApi: {}, discoveryApi: {}, moderationApi: {},
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
vi.mock('../../../lib/clipboard', () => ({ copyText: (t: string) => { fx.copied.push(t); return true; } }));
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
  id: 'order-1', orderNumber: 'SW-261108-003K2E', orderType: 'FOOD_DELIVERY', status: 'CANCELLED', fulfillment: 'DELIVERY',
  vendor: { id: 'store-1', name: 'Window Diner', vendorType: 'RESTAURANT' }, items: [], placedAt: '2026-11-08T15:20:00.000Z',
  paymentMethod: 'CASH', paymentStatus: 'PENDING', canCancel: false, totalAmount: 2800, subtotal: 2500,
  paymentAction: null, mmgPayment: null, cancellationNotice: null, cancellationReason: 'Out of stock',
  cancellation: { by: 'STORE', reason: 'Out of stock' },
};
const answer = (data: unknown) => ({ data: { data } });

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };
async function show(order: Record<string, unknown>) {
  fx.getOrder.mockResolvedValue(answer(order));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(DeliveryScreen))));
  await flush();
  expect(host.textContent).toContain('SW-261108-003K2E');
}
const card = () => host.querySelector('[data-testid="order-closed-card"]')?.textContent ?? '';
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  vi.clearAllMocks();
  fx.handlers.clear(); fx.copied.length = 0;
  fx.getOrder.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.clear();
});

describe('[owner 8 Nov 2026] the order screen says the store declined it, and why', () => {
  it('RED reproduction — cash, declined as out of stock: the reason, "You weren’t charged.", and another store one tap away', async () => {
    await show(ORDER);
    expect(card()).toContain('The store declined your order: Out of stock.');
    expect(card()).toContain('You weren’t charged.');
    expect(card()).not.toContain('This order was cancelled.');
    const another = button('Order from another store');
    expect(another).not.toBeNull();
    await act(async () => { another!.click(); });
    expect(fx.navigate).toHaveBeenCalledWith('Search', { type: 'RESTAURANT' });
  });

  it('MMG still waiting for "Paid by MMG": never "not charged", the store refunds directly', async () => {
    await show({ ...ORDER, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' });
    expect(card()).toContain('The store declined your order: Out of stock.');
    expect(card()).toContain('If you already sent the MMG payment, the store refunds you directly.');
    expect(card()).not.toContain('charged');
  });

  it('MMG in any other state (the refund card speaks for it): no money words at all', async () => {
    await show({ ...ORDER, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' });
    expect(card()).toContain('The store declined your order: Out of stock.');
    expect(card()).not.toMatch(/charged|refund/);
  });

  it('a booking declined by its provider: provider words, and another provider one tap away', async () => {
    await show({
      ...ORDER, fulfillment: 'APPOINTMENT', vendor: { id: 'svc', name: 'Kim’s Barbershop', vendorType: 'SERVICE' },
      cancellation: { by: 'STORE', reason: 'Fully booked at that time' },
    });
    expect(card()).toContain('The provider declined your booking: Fully booked at that time.');
    await act(async () => { button('Book with another provider')!.click(); });
    expect(fx.navigate).toHaveBeenCalledWith('Search', { type: 'SERVICE' });
  });

  it('the store never answered: its own words, the money line, and another store', async () => {
    await show({ ...ORDER, cancellation: { by: 'NO_RESPONSE', reason: null } });
    expect(card()).toContain('The store didn’t respond in time, so your order was cancelled.');
    expect(card()).toContain('You weren’t charged.');
    expect(button('Order from another store')).not.toBeNull();
  });

  it('the customer’s own cancel and Swift support’s: their own words, no "another store" button', async () => {
    await show({ ...ORDER, cancellation: { by: 'CUSTOMER', reason: null } });
    expect(card()).toContain('You cancelled this order.');
    expect(button('Order from another store')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host); client.clear();
    await show({ ...ORDER, cancellation: { by: 'SWIFT', reason: null } });
    expect(card()).toContain('Swift support cancelled this order.');
    // Support may close an order at any stage: no claim about cash.
    expect(card()).not.toContain('charged');
    expect(button('Order from another store')).toBeNull();
  });

  it('an older server (no `cancellation`): the screen keeps its own words', async () => {
    await show({ ...ORDER, cancellation: undefined });
    expect(card()).toContain('This order was cancelled.');
    expect(button('Order from another store')).toBeNull();
  });

  it('the unpaid-MMG notice still wins (the server’s whole sentence)', async () => {
    const notice = 'No MMG payment was confirmed within 30 minutes of Window Diner accepting, so this order was cancelled automatically. If you did send the MMG payment, Window Diner refunds you directly. If it does not, contact Swift support.';
    await show({ ...ORDER, paymentMethod: 'MOBILE_MONEY', cancellationNotice: notice, cancellation: { by: 'SYSTEM', reason: notice } });
    expect(card()).toContain(notice);
    expect(card().split(notice).length).toBe(2); // said once
  });

  it('live: on the screen when the store declines, the card appears from the socket event (no reload), and the reads settle', async () => {
    await show({ ...ORDER, status: 'PENDING', canCancel: true, cancellation: null, cancellationReason: null });
    expect(card()).toBe('');
    fx.getOrder.mockResolvedValue(answer(ORDER));
    const onStatus = fx.handlers.get('order:status_changed');
    expect(onStatus).toBeTypeOf('function');
    await act(async () => { onStatus!({ orderId: 'order-1', status: 'CANCELLED', reason: 'Out of stock' }); });
    await flush();
    expect(card()).toContain('The store declined your order: Out of stock.');
    // No render loop: the reads stop once the order is on screen.
    const reads = fx.getOrder.mock.calls.length;
    await flush(); await flush();
    expect(fx.getOrder.mock.calls.length).toBe(reads);
  });
});
