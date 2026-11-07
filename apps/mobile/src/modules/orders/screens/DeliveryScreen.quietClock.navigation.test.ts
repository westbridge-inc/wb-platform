/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED C · report item 8] The order screen's clock and map.
//   - The screen redrew itself whole every 3 s (even hidden, even on a finished order) so a few time-based facts
//     would flip on time. Its clock now moves only at those moments (hooks/useDeadlineClock) and never while the
//     screen is hidden or Swift is in the background; shown again, the facts are read against the real time at once.
//   - The map is memoised and its pins are drawn once per look (QuietMarker: tracksViewChanges on while the icon
//     first draws, then off [review S3-2]); the rider's pin is drawn again when it fades.
//   - A return to the screen keeps the rider's last fix instead of dropping the rider until the next one.
// The REAL order screen over the REAL order hooks and a real query client (DeliveryScreen.opening's setup); the
// transport, the socket, native drawing and the toast are stand-ins; time is the test's.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  getOrder: vi.fn(),
  cancelOrder: vi.fn(),
  handlers: new Map<string, (payload?: unknown) => void>(),
  toastError: vi.fn(),
  toastShow: vi.fn(),
  focused: true,
  appState: null as null | ((state: string) => void),
  markers: [] as any[],
  draws: 0,
  mapDraws: 0,
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
    AppState: { currentState: 'active', addEventListener: (_e: string, fn: (s: string) => void) => { fx.appState = fn; return { remove() { fx.appState = null; } }; } },
    Share: { share: vi.fn() },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  return {
    __esModule: true,
    default: (p: any) => { fx.mapDraws += 1; return R.createElement('div', { 'data-map': '' }, p.children); },
    Marker: (p: any) => { fx.markers.push(p); return R.createElement('div', { 'data-marker': p.title, 'data-key-tracks': String(p.tracksViewChanges) }); },
  };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => fx.focused,
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
  const hold = await import('../../../kit/hold-window');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const Box = (p: any) => h('div', a11y(p), p.children);
  const T = (p: any) => h('span', a11y(p), p.children);
  return {
    T, Eyebrow: T, PopupTitle: T, DecorativeIcon: Box, IconChip: () => null,
    // Drawn once per screen draw (the map's Back chip): the screen's draw count.
    CircleChip: (p: any) => { if (p.label === 'Go back') fx.draws += 1; return Box(p); },
    InfoRow: (p: any) => h('div', null, p.label, p.value),
    Timeline: () => null, HoldRing: () => null, LoadingBlock: () => h('div', null, 'Loading'), ErrorState: () => h('div', null, 'Error'),
    // The kit header (its Back chip) on the loading and failure branches [UI-SWEEP U32].
    Header: () => h('div', { 'aria-label': 'Back' }),
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, disabled: !!(p.disabled || p.loading), onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    // The real pure hold-window seams: the hold closing is what the clock must flip on time.
    holdRingCaption: hold.holdRingCaption, holdRingWindow: hold.holdRingWindow,
  };
});

import { DeliveryScreen } from './DeliveryScreen';
import { resetFixDrops } from '../../../lib/liveFix';
import { MARKER_SETTLE_MS } from '../../movement/map/QuietMarker';

const T0 = Date.parse('2026-11-07T15:00:00.000Z');
const BASE = {
  id: 'order-1', orderNumber: 'SW-1001', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
  vendor: { id: 'store-1', name: 'Test store' }, items: [], placedAt: new Date(T0 - 60_000).toISOString(),
  paymentMethod: 'CASH', paymentStatus: 'PENDING', canCancel: false, totalAmount: 2500, subtotal: 2500,
  pickupLat: 6.81, pickupLng: -58.15, deliveryLat: 6.8, deliveryLng: -58.16,
};
const answer = (data: unknown) => ({ data: { data } });

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };
const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const draw = async () => { await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(DeliveryScreen)))); await settle(); };
const text = () => host.textContent ?? '';
const rider = () => host.querySelector('[data-marker^="Your rider"], [data-marker^="Rider"]');

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.clearAllMocks();
  resetFixDrops();
  fx.handlers.clear(); fx.focused = true; fx.markers = []; fx.draws = 0; fx.mapDraws = 0;
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.clear();
  vi.useRealTimers();
});

describe('[APP-SPEED C] the order screen redraws only when a time-based fact flips', () => {
  it('nothing time-based on screen (no hold, no promise, no rider fix): a minute passes with no redraw', async () => {
    fx.getOrder.mockResolvedValue(answer({ ...BASE, status: 'PREPARING' }));
    await draw();
    expect(text()).toContain('SW-1001');
    const before = fx.draws;
    await pass(60_000);
    expect(fx.draws - before, 'the old 3 s tick drew it 20 times').toBe(0);
  });

  it('the hold closes exactly on time: "held" until the server time, the release words from the next millisecond', async () => {
    fx.getOrder.mockResolvedValue(answer({ ...BASE, status: 'PENDING', canCancel: true, holdExpiresAt: new Date(T0 + 10_000).toISOString() }));
    await draw();
    expect(text()).toContain('Order #SW-1001 — held');
    const before = fx.draws;
    await pass(9_000);
    expect(fx.draws - before, 'no redraw while nothing flips').toBe(0);
    expect(text()).toContain('Order #SW-1001 — held');
    await pass(1_002);
    expect(text()).toContain('The wait is over. Checking whether your order was sent.');
    expect(text()).not.toContain('— held');
  });

  it('hidden: no clock at all; shown again: the facts are read against the real time at once', async () => {
    fx.getOrder.mockResolvedValue(answer({ ...BASE, status: 'PENDING', canCancel: true, holdExpiresAt: new Date(T0 + 10_000).toISOString() }));
    await draw();
    fx.focused = false;
    await draw();
    const hidden = fx.draws;
    await pass(30_000);
    expect(fx.draws - hidden, 'a hold closing behind another screen redraws nothing').toBe(0);
    fx.focused = true;
    await draw();
    expect(text()).toContain('The wait is over. Checking whether your order was sent.');
  });

  it('Swift in the background: no clock; back in the foreground: read at once', async () => {
    fx.getOrder.mockResolvedValue(answer({ ...BASE, status: 'PENDING', canCancel: true, holdExpiresAt: new Date(T0 + 10_000).toISOString() }));
    await draw();
    await act(async () => { fx.appState?.('background'); });
    const away = fx.draws;
    await pass(30_000);
    expect(fx.draws - away).toBe(0);
    await act(async () => { fx.appState?.('active'); });
    await settle();
    expect(text()).toContain('The wait is over. Checking whether your order was sent.');
  });
});

describe('[APP-SPEED C] the map: pins drawn once, the rider kept across a return', () => {
  const fix = async (at: number) => {
    await act(async () => { fx.handlers.get('rider:location')?.({ orderId: 'order-1', lat: 6.805, lng: -58.155, ts: new Date(at).toISOString(), etaMinutes: 6 }); });
    await settle();
  };

  /** Each pin's tracksViewChanges as last drawn. */
  const lastTracks = () => Object.fromEntries(fx.markers.map((m) => [m.title, m.tracksViewChanges]));

  it('every pin draws its icon, then is drawn once (tracksViewChanges off after it settles)', async () => {
    fx.getOrder.mockResolvedValue(answer({ ...BASE, status: 'RIDER_ASSIGNED', rider: { firstName: 'Ravi' } }));
    await draw();
    await fix(T0);
    expect(rider()?.getAttribute('data-marker')).toBe('Your rider');
    expect(lastTracks()['Your rider'], 'on while the glyph first draws (never a blank pin on Android)').toBe(true);
    await pass(MARKER_SETTLE_MS);
    const tracks = lastTracks();
    expect(Object.keys(tracks)).toEqual(expect.arrayContaining(['Test store', 'Delivery address', 'Your rider']));
    expect(Object.values(tracks).every((t) => t === false)).toBe(true);
  });

  it('the rider fades exactly when the fix goes stale (15 s), and its pin is drawn again for the new look', async () => {
    fx.getOrder.mockResolvedValue(answer({ ...BASE, status: 'RIDER_ASSIGNED', rider: { firstName: 'Ravi' } }));
    await draw();
    await fix(T0);
    const keys = () => fx.markers.filter((m) => /rider/i.test(m.title)).map((m) => m.title);
    await pass(14_000);
    expect(rider()?.getAttribute('data-marker')).toBe('Your rider');
    await pass(1_002);
    expect(rider()?.getAttribute('data-marker')).toBe('Rider — last received location');
    expect(keys()).toContain('Rider — last received location');
    expect(lastTracks()['Rider — last received location'], 'the faded look is drawn').toBe(true);
    await pass(MARKER_SETTLE_MS);
    expect(lastTracks()['Rider — last received location']).toBe(false);
  });

  it('a redraw of the screen that moves no pin does not redraw the map', async () => {
    fx.getOrder.mockResolvedValue(answer({ ...BASE, status: 'PREPARING' }));
    await draw();
    const maps = fx.mapDraws;
    const draws = fx.draws;
    await act(async () => { await client.refetchQueries(); });
    await settle();
    await draw();
    expect(fx.draws).toBeGreaterThan(draws);
    expect(fx.mapDraws - maps).toBe(0);
  });

  it('a return to the screen keeps the rider (its last fix), not an empty map until the next fix', async () => {
    fx.getOrder.mockResolvedValue(answer({ ...BASE, status: 'RIDER_ASSIGNED', rider: { firstName: 'Ravi' } }));
    await draw();
    await fix(T0);
    expect(rider()).not.toBeNull();
    fx.focused = false;
    await draw();
    fx.focused = true;
    await draw();
    expect(rider(), 'the rider is still on the map').not.toBeNull();
    expect(text()).toContain('Rider arriving in ~6 min');
  });
});
