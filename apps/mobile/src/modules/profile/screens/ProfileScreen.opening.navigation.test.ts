/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED A · owner 7 Nov] The Profile tab opened on a spinner although the
// phone already knew who is signed in. The signed-in person (auth store) now
// stands in while the first profile read is on its way: their name at once;
// the profile's own facts (orders, member since, what is done) are NOT drawn
// until the server answers, and a failed read is the error screen as before.
// The REAL ProfileScreen over the REAL profile hook and a real query client;
// native drawing, the kit and the transport are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  user: { id: 'u-1', firstName: 'Asha', lastName: 'Persaud', avatar: null } as Record<string, unknown> | null,
  getProfile: vi.fn(),
  myRating: vi.fn(() => new Promise(() => {})),
  getOrders: vi.fn(() => new Promise(() => {})),
  signedIn: true,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return { View, ScrollView: View, Pressable: View, StyleSheet: { create: (s: unknown) => s, absoluteFill: {}, hairlineWidth: 1 } };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-reanimated', async () => {
  const R = await import('react');
  const chain: any = { duration: () => chain, delay: () => chain, reduceMotion: () => chain };
  return { default: { View: (p: any) => R.createElement('div', null, p.children) }, FadeInDown: chain, ReduceMotion: {} };
});
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../lib/haptics', () => ({ haptic: { select: vi.fn() } }));
// The REAL hooks/customer runs; these are its own dependencies.
vi.mock('../../../services/api', () => ({
  API_URL: 'https://api.example.test',
  customerApi: {
    getProfile: fx.getProfile,
    myRating: fx.myRating,
    getOrders: fx.getOrders,
    getConsent: () => new Promise(() => {}),
    setMarketingConsent: vi.fn(),
  },
  marketApi: {}, discoveryApi: {}, moderationApi: {}, rideApi: {},
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../../../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn(), checkoutFailureOutcome: vi.fn(), settleUnresolvedIntent: vi.fn() }));
vi.mock('../../../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../../../stores/authStore', () => {
  const state = () => ({ isAuthenticated: fx.signedIn, promptLogin: vi.fn(), user: fx.user, setIntent: vi.fn(), sessionGeneration: 1 });
  return {
    useAuthStore: Object.assign((select?: (s: ReturnType<typeof state>) => unknown) => (select ? select(state()) : state()), { getState: state }),
    getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: vi.fn(), AuthSessionBoundaryError: class extends Error {},
  };
});
vi.mock('../../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: () => null }));
vi.mock('../../safety/MonitoringControl', () => ({ MonitoringControl: () => null }));
vi.mock('../../../lib/payLink', () => ({ openPayLink: vi.fn() }));
vi.mock('../../../kit/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), show: vi.fn() } }));
vi.mock('../../../kit/controls', () => ({ BrandSwitch: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Nothing = () => null;
  const Box = (p: any) => h('div', null, p.children);
  return {
    EmptyState: Nothing, ErrorState: () => h('div', { 'data-error': '' }), IconChip: Nothing, LoadingBlock: () => h('div', { 'data-loading': '' }),
    PillButton: (p: any) => h('button', { type: 'button' }, p.label),
    PopupCard: Nothing, PopupTitle: Nothing, Screen: Box, Chip: Nothing,
    TrustHalo: (p: any) => h('div', { 'data-facts': p.facts.map(String).join(',') }, p.children),
    T: (p: any) => h('span', null, p.children),
    useLogoutConfirm: () => ({ requestLogout: vi.fn(), logoutDialog: null }),
    SettingsRow: (p: any) => h('section', { 'data-row': p.label }),
  };
});

import { ProfileScreen } from './ProfileScreen';

const PROFILE = { firstName: 'Asha', lastName: 'Persaud', createdAt: '2026-03-01T12:00:00Z', customer: { totalOrders: 2 }, unreadNotifications: 0 };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };
async function open() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ProfileScreen))));
}
const later = () => {
  let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  fx.user = { id: 'u-1', firstName: 'Asha', lastName: 'Persaud', avatar: null };
  fx.getProfile.mockReset(); fx.myRating.mockClear(); fx.getOrders.mockClear(); fx.signedIn = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('[APP-SPEED A] Profile opens on the signed-in person', () => {
  it('their name at once, the profile’s facts unknown ("checking"), then the server’s profile', async () => {
    const read = later();
    fx.getProfile.mockImplementationOnce(() => read.promise);
    await open();

    // (a) at once, from the auth store
    expect(host.querySelector('[data-loading]')).toBeNull();
    expect(host.textContent).toContain('Asha Persaud');
    expect(host.textContent).toContain('Checking your account…');
    // (b) nothing the profile has not said: no order count, no "done" facts, no member-since
    expect(host.textContent).not.toMatch(/With Swift since|\d+ orders?\b|done — next|Account complete/);
    expect(host.querySelector('[data-facts]')!.getAttribute('data-facts')).toBe('');

    // (c) the server's profile replaces it
    read.resolve({ data: { data: PROFILE } });
    await flush();
    expect(host.textContent).not.toContain('Checking your account…');
    expect(host.textContent).toContain('With Swift since 2026 · 2 orders');
    expect(host.textContent).toContain('Account complete');
    expect(host.querySelector('[data-facts]')!.getAttribute('data-facts')).toBe('true,true');
  });

  it('a failed first read is the error screen, never the stand-in', async () => {
    const read = later();
    fx.getProfile.mockImplementationOnce(() => read.promise);
    await open();
    expect(host.textContent).toContain('Asha Persaud');
    read.reject(Object.assign(new Error('Request failed'), { response: { status: 503 } }));
    await flush();
    expect(host.querySelector('[data-error]')).not.toBeNull();
    expect(host.textContent).not.toContain('Asha Persaud');
  });

  it('no signed-in person in the store: the plain loading state, as before', async () => {
    fx.user = null;
    fx.getProfile.mockImplementationOnce(() => new Promise(() => {}));
    await open();
    expect(host.querySelector('[data-loading]')).not.toBeNull();
  });
});

describe('[APP-SPEED A · review S3] a guest’s Profile (drawn ahead, hidden) reads nothing', () => {
  it('no profile, rating or live-orders read for a guest', async () => {
    fx.signedIn = false;
    fx.user = null;
    await open();
    await flush();
    expect(fx.getProfile).not.toHaveBeenCalled();
    expect(fx.myRating).not.toHaveBeenCalled();
    expect(fx.getOrders).not.toHaveBeenCalled();
  });
});

