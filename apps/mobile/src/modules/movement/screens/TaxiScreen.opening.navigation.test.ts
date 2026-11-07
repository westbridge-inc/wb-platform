/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ESTIMATE_WITHOUT_STOPS,
  ESTIMATE_WITH_ONE_STOP,
  REQUEST_ANSWER_WITH_ONE_STOP,
  riderRideWithoutStops,
} from '../../../lib/taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [APP-SPEED A · owner 7 Nov] The Taxi door showed a full-screen spinner until
// "is a ride in progress?" came back. Now the booking form draws at once and
// Request (and Join the queue) is HELD until that answer lands; a remembered
// ride shows at once with Cancel and "My driver is here" held until the
// server answers for it. The REAL TaxiScreen over the real ride hooks, API
// client and Axios instance (the harness of TaxiScreen.multistop, whose
// capturing adapter here may also answer late).
// ---------------------------------------------------------------------------

type Reply = { status: number; data?: unknown; network?: boolean };
type Handler = (config: InternalAxiosRequestConfig) => Reply | Promise<Reply>;

const fx = vi.hoisted(() => {
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  const socketHandlers = new Map<string, Set<(payload: unknown) => void>>();
  /** React Native style → DOM style, enough to read a render capture. */
  const css = (style: unknown): Record<string, unknown> | undefined => {
    const flat: Record<string, unknown> = {};
    const walk = (s: unknown) => { if (Array.isArray(s)) s.forEach(walk); else if (s && typeof s === 'object') Object.assign(flat, s); };
    walk(style);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(flat)) {
      if (v == null || typeof v === 'object') continue;
      if (k === 'paddingHorizontal') { out['paddingLeft'] = v; out['paddingRight'] = v; continue; }
      if (k === 'paddingVertical') { out['paddingTop'] = v; out['paddingBottom'] = v; continue; }
      if (k === 'marginHorizontal') { out['marginLeft'] = v; out['marginRight'] = v; continue; }
      if (k === 'marginVertical') { out['marginTop'] = v; out['marginBottom'] = v; continue; }
      if (/^(shadow|elevation)/.test(k)) continue;
      out[k] = v;
      if (k === 'borderWidth' || k === 'borderTopWidth') out['borderStyle'] = 'solid';
    }
    return Object.keys(out).length ? out : undefined;
  };
  return {
    css,
    routes: {} as Record<string, (config: any) => { status: number; data?: unknown; network?: boolean } | Promise<{ status: number; data?: unknown; network?: boolean }>>,
    seen: [] as any[],
    storage: new Map<string, string>(),
    navigate: vi.fn(),
    socketHandlers,
    socket: {
      on: (event: string, fn: (payload: unknown) => void) => { if (!socketHandlers.has(event)) socketHandlers.set(event, new Set()); socketHandlers.get(event)!.add(fn); },
      off: (event: string, fn: (payload: unknown) => void) => { socketHandlers.get(event)?.delete(fn); },
      emit: () => undefined,
      connected: true,
    },
    fire: (event: string, payload: unknown) => { for (const fn of [...(socketHandlers.get(event) ?? [])]) fn(payload); },
  };
});

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({
    'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole,
    'aria-selected': p.accessibilityState?.selected, 'aria-disabled': p.accessibilityState?.disabled ?? p.disabled,
  });
  const View = (p: any) => h('div', { ...a11y(p), style: fx.css(p.style) }, p.children);
  const Text = (p: any) => h('span', { ...a11y(p), style: fx.css(p.style) }, p.children);
  const Pressable = (p: any) => h('div', {
    ...a11y(p), role: p.accessibilityRole ?? 'button', style: fx.css(typeof p.style === 'function' ? p.style({ pressed: false }) : p.style),
    onClick: p.disabled ? undefined : p.onPress,
  }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Text, Pressable, ScrollView: View, Image: View, ActivityIndicator: () => null,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    TurboModuleRegistry: { get: () => null },
    Share: { share: vi.fn(async () => ({})) },
    Linking: { openURL: vi.fn(async () => true) },
    useColorScheme: () => 'light',
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    AppState: { addEventListener: () => ({ remove() {} }), currentState: 'active' },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  const h = R.createElement;
  const MapView = R.forwardRef((p: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({ animateToRegion() {}, fitToCoordinates() {} }));
    return h('div', { 'data-map': '' }, p.children);
  });
  const Marker = (p: any) => h('div', { 'data-marker': p.title ?? '' }, p.children);
  return { __esModule: true, default: MapView, Marker, MarkerAnimated: Marker, PROVIDER_DEFAULT: 'default', Polyline: () => null };
});
vi.mock('react-native-reanimated', () => ({ __esModule: true, default: { createAnimatedComponent: (c: unknown) => c } }));
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  const Sheet = R.forwardRef((p: any, _ref: any) => R.createElement('section', null, p.children));
  return { __esModule: true, default: Sheet, BottomSheetScrollView: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const { money } = await import('../../../lib/money');
  const { color } = await import('@swift/ui');
  const SIZE: Record<string, number> = { displayXl: 30, display: 26, title: 20, heading: 17, body: 15, bodyStrong: 15, label: 14, caption: 13, micro: 11 };
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const Box = (p: any) => h('div', { ...a11y(p), style: fx.css([{ display: 'flex', flexDirection: 'column', background: color.surface.base, borderRadius: 16, padding: 16 }, p.style]) }, p.children);
  const T = (p: any) => h('span', { ...a11y(p), style: fx.css([{ display: 'block', fontSize: SIZE[p.variant ?? 'body'], fontWeight: p.weight === 'bold' || p.weight === 'semibold' ? 600 : 400 }, p.style]) }, p.children);
  const PillButton = (p: any) => h('button', {
    type: 'button', 'data-testid': p.testID, 'aria-label': p.label, disabled: !!(p.disabled || p.loading),
    onClick: p.disabled || p.loading ? undefined : p.onPress,
    style: { display: 'block', width: '100%', minHeight: 48, borderRadius: 999, marginTop: 8, borderWidth: 1, borderStyle: 'solid', borderColor: color.border.subtle, background: p.variant === 'primary' || !p.variant ? color.brand[500] : color.surface.base, color: p.variant === 'primary' || !p.variant ? color.text.onBrand : color.text.primary },
  }, p.label);
  return {
    T, Eyebrow: T, PopupTitle: T, Card: Box,
    PillButton,
    // Typable, so the courier form can be filled (TaxiScreen draws none).
    LabeledInput: (p: any) => h('input', { value: p.value ?? '', placeholder: p.placeholder, onChange: (e: any) => p.onChangeText?.(e.target.value) }),
    TonePill: (p: any) => h('span', null, p.label),
    // [owner #67] The courier form's "This parcel has no prohibited items" tick.
    BrandCheckbox: (p: any) => h('button', { type: 'button', role: 'checkbox', 'aria-label': p.label, 'aria-checked': !!p.checked, onClick: p.onToggle }),
    Money: (p: any) => h('span', null, money(p.amount)),
    CircleChip: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }, ''),
    StatePill: (p: any) => h('span', { 'data-pill': '', style: { borderWidth: 1, borderStyle: 'solid', borderColor: color.border.subtle, borderRadius: 99, padding: '2px 8px', fontSize: 11 } }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    CalmRadar: (p: any) => h('div', null, p.title),
    EmptyState: (p: any) => h('div', null, p.title),
    LoadingBlock: () => h('div', null, 'Loading'),
    IconChip: () => null, DecorativeIcon: () => null, Pictogram: () => null, PinGlyph: () => null, Stars: () => null, VehicleRender: () => null,
    cardShadow: {},
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../kit/map-style', () => ({ rideMapProps: () => ({}) }));
vi.mock('../map/useInterpolatedDriver', () => ({ useInterpolatedDriver: () => ({ hasFix: false, stale: false, animatedProps: {} }) }));
// The real ride hooks, through the real API client; nothing else from the hooks barrel.
vi.mock('../../../hooks', async () => ({
  ...(await vi.importActual<typeof import('../../../hooks/rides')>('../../../hooks/rides')),
  ...(await vi.importActual<typeof import('../../../hooks/courier')>('../../../hooks/courier')),
}));
vi.mock('../../../kit/journey-rail', async () => {
  const R = await import('react');
  return { JourneyRail: (p: any) => R.createElement('div', null, p.start, p.end) };
});
vi.mock('../../../hooks/mover', () => ({ evidenceFix: () => { throw new Error('No mover evidence in a customer quote test'); } }));
vi.mock('../../../hooks/customer', () => ({ customerKeys: { homeAll: ['customer', 'home'] } }));
vi.mock('../../../hooks/useDeviceLocation', () => ({ useDeviceLocation: () => ({ resolve: vi.fn() }) }));
vi.mock('../../../services/socket', () => ({ connectSocket: vi.fn(), getSocket: () => fx.socket, subscribeToOrder: vi.fn() }));
// The post-trip sheet has its own render test; here it shows only what it was handed.
vi.mock('../RidePostTripSheet', async () => {
  const R = await import('react');
  return { RidePostTripSheet: (p: any) => (p.ride ? R.createElement('output', { 'data-testid': 'post-trip' }, String(p.ride.fareBreakdown?.total ?? 'no breakdown')) : null) };
});
vi.mock('../../../stores/locationStore', () => ({
  useLocationStore: () => ({ latitude: 6.8013, longitude: -58.1553, address: 'Stabroek Market', status: 'granted' }),
}));
vi.mock('../../../components/LocationPrimerCard', () => ({ LocationPrimerCard: () => null }));
vi.mock('../../../lib/images', () => ({ mediaUrl: (x: unknown) => x }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), commit: vi.fn(), warn: vi.fn(), failure: vi.fn(), select: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: vi.fn() }));
// The live ride now hosts the SOS ceremony (TaxiScreen.sos.navigation.test.ts), which reads the market policy too.
vi.mock('../../../services/emergencyPolicy', () => ({ currentMarketDial: () => ({ kind: 'manual' }), emergencyDialCopy: () => '', previewEmergencyDial: () => null, useEmergencyPolicy: () => ({ country: 'GY', dial: { kind: 'manual' } }), emergencyDialFor: () => ({ kind: 'manual' }) }));
vi.mock('../taxiEntry', () => ({ signInForTaxi: vi.fn() }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('../../../lib/storage', () => ({
  zustandStorage: {
    getItem: (k: string) => fx.storage.get(k) ?? null,
    setItem: (k: string, v: string) => { fx.storage.set(k, v); },
    removeItem: (k: string) => { fx.storage.delete(k); },
  },
}));
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, promptLogin: vi.fn(), countryCode: 'GY', user: { id: 'rider-1', firstName: 'Asha' } };
  const useAuthStore = Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => ({ ...state, rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }),
  });
  const session = () => ({ userId: 'rider-1', generation: 1, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' });
  return {
    useAuthStore,
    AuthSessionBoundaryError: class extends Error {},
    getAuthSessionSnapshot: session,
    requireAuthSessionSnapshot: session,
    requireAuthSessionForPrincipal: session,
    isAuthSessionSnapshotCurrent: () => true,
  };
});

import { api } from '../../../services/api';
import { TaxiScreen } from './TaxiScreen';

const LAMAHA = { lat: 6.82, lng: -58.16, label: 'Lamaha Street' };

const ok = (data: unknown, status = 200): Reply => ({ status, data: { success: true, data } });
const refuse = (status: number, code: string, details?: unknown): Reply => ({ status, data: { success: false, error: { code, message: `server words for ${code}`, details } } });
const bodyOf = (config: any) => (config?.data ? JSON.parse(String(config.data)) : undefined);
const sent = (route: string) => fx.seen.filter((c) => `${c.method} ${String(c.url).split('?')[0]}` === route);

/** Quotes like the part-2 engine: one stop → the contract's answer; more → a bigger whole-route fare. */
function quote(config: any): Reply {
  const stops = bodyOf(config)?.stops as unknown[] | undefined;
  if (!stops?.length) return { status: 200, data: ESTIMATE_WITHOUT_STOPS };
  if (stops.length === 1) return { status: 200, data: ESTIMATE_WITH_ONE_STOP };
  const fare = 2800 + 600 * (stops.length - 1);
  return ok({ ...ESTIMATE_WITH_ONE_STOP.data, tiers: [{ rideClass: 'ECONOMY', multiplier: 1, fare, capacity: 4, source: 'formula' }], stopCount: stops.length });
}

const adapter: AxiosAdapter = async (config) => {
  fx.seen.push(config);
  const key = `${config.method} ${String(config.url).split('?')[0]}`;
  const handler: Handler | undefined = fx.routes[key];
  const reply = handler ? await handler(config) : refuse(404, 'NOT_FOUND');
  if (reply.network) throw new AxiosError('Network Error', 'ERR_NETWORK', config);
  const response = { config, status: reply.status, statusText: String(reply.status), headers: {}, data: reply.data };
  if (reply.status >= 200 && reply.status < 300) return response;
  throw new AxiosError(`Request failed with status code ${reply.status}`, reply.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, null, response as never);
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const navigation = { navigate: fx.navigate, goBack: vi.fn(), replace: vi.fn(), isFocused: () => true };

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(TaxiScreen, { navigation }))));
  await settle();
}
const text = () => host.textContent ?? '';
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
async function click(el: HTMLElement | null) {
  expect(el, 'the control is on screen').toBeTruthy();
  await act(async () => { el!.click(); });
  await settle();
}
/** The search screen hands a picked place back through the route param. */
async function pickFromSearch(open: HTMLElement | null, place: { lat: number; lng: number; label: string }) {
  await click(open);
  const call = fx.navigate.mock.calls.at(-1)!;
  expect(call[0]).toBe('DestinationSearch');
  await act(async () => { (call[1] as { onSelect: (p: unknown) => void }).onSelect(place); });
  await settle();
}
const requestButton = () => Array.from(host.querySelectorAll('button')).find((b) => /^Request /.test(b.textContent ?? '')) as HTMLElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  fx.seen.length = 0;
  fx.storage.clear();
  fx.socketHandlers.clear();
  fx.routes = {
    'get /rides/active': () => ok(null),
    'get /rides/capabilities': () => refuse(404, 'NOT_FOUND'),
    'post /rides/estimate': quote,
    'get /rides/availability': () => ok({ level: 'GOOD', nearestEtaMinutes: 3, gate: false }),
    'get /rides/supply': () => ok({ online: 3, busy: 0, level: 'GOOD', nearestEtaMinutes: 3 }),
    'get /rides/presence': () => ok({ cars: [] }),
    'get /rides/queue': () => ok(null),
    'post /rides/request': () => ({ status: 201, data: REQUEST_ANSWER_WITH_ONE_STOP }),
    'get /safety/guardian/checkin': () => ok(null),
  };
  api.defaults.adapter = adapter;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.useRealTimers();
});

const later = () => {
  let resolve!: (reply: Reply) => void;
  const promise = new Promise<Reply>((res) => { resolve = res; });
  return { promise, resolve };
};

describe('[APP-SPEED A] the Taxi door opens on the form; booking waits for the answer', () => {
  it('no ride remembered: the form draws at once, Request is held and says why, and the answer frees it', async () => {
    const active = later();
    fx.routes['get /rides/active'] = () => active.promise;
    await mount();

    // (a) the form, at once — no spinner in its place
    expect(byLabel('Where to?. Choose your destination')).toBeTruthy();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    expect(requestButton(), 'the fare is on the button').toBeTruthy();
    // (b) held until the server says no ride is in progress
    expect((requestButton() as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain('Checking for a ride in progress…');
    await click(requestButton() ?? null);
    expect(sent('post /rides/request')).toHaveLength(0);

    // (c) the answer: no ride — Request is live
    active.resolve(ok(null));
    await settle();
    expect(text()).not.toContain('Checking for a ride in progress…');
    expect((requestButton() as HTMLButtonElement).disabled).toBe(false);
    await click(requestButton() ?? null);
    expect(sent('post /rides/request')).toHaveLength(1);
  });

  it('the answer is a ride in progress: the form is replaced by the ride, nothing was booked', async () => {
    const active = later();
    fx.routes['get /rides/active'] = () => active.promise;
    await mount();
    await pickFromSearch(byLabel('Where to?. Choose your destination'), LAMAHA);
    active.resolve(ok(riderRideWithoutStops({ status: 'DRIVER_EN_ROUTE', ridePinVerified: false })));
    await settle();
    expect(requestButton()).toBeUndefined();
    expect(byLabel('Cancel ride')).toBeTruthy();
    expect(sent('post /rides/request')).toHaveLength(0);
  });

  it('a remembered ride shows at once, but Cancel and "My driver is here" wait for the server’s own answer', async () => {
    client.setQueryData(['rides', 'active'], riderRideWithoutStops({ status: 'DRIVER_EN_ROUTE', ridePinVerified: false }));
    const active = later();
    fx.routes['get /rides/active'] = () => active.promise;
    fx.routes['post /rides/:id/cancel'] = () => ok({ message: 'Ride cancelled.' });
    await mount();

    const cancel = byLabel('Cancel ride') as HTMLButtonElement | null;
    const here = byLabel('My driver is here') as HTMLButtonElement | null;
    expect(cancel, 'the remembered ride is drawn at once').toBeTruthy();
    expect(cancel!.disabled).toBe(true);
    expect(here!.disabled).toBe(true);

    active.resolve(ok(riderRideWithoutStops({ status: 'DRIVER_EN_ROUTE', ridePinVerified: false })));
    await settle();
    expect((byLabel('Cancel ride') as HTMLButtonElement).disabled).toBe(false);
    expect((byLabel('My driver is here') as HTMLButtonElement).disabled).toBe(false);
  });
});
