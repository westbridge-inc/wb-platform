/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-INTRO · owner 8 Nov 2026] A fresh install, signed out: the brand intro, then the welcome's four doors, and
// each door goes on into the sign-up the app already had, with the right role.
//
// REAL here: RootNavigator and its root stack and entry gate, the welcome screen (RolePickerScreen), the sign-in
// stack and its phone screen, the auth store with its persistence, the app store, the ads switch hook and the
// brand intro, composed exactly as App.tsx composes them (the intro after the navigator, over it). Stand-ins: the
// customer, driver and business apps (each a screen that says which app it is), native drawing, Reanimated's UI
// thread (a recorder on a clock the test advances, as in components/LaunchIntro.navigation.test.ts) and the HTTP
// transport (one capability read, held open unless a test answers it).
// ---------------------------------------------------------------------------

type Anim = { to: number; delay: number; duration: number; cb?: (finished?: boolean) => void; startedAt: number; settled: boolean; sv: { raw: number } };

const fx = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  now: 0,
  anims: [] as Anim[],
  reduced: false,
  splashOptions: [] as unknown[],
  storage: new Map<string, string>(),
  capability: null as null | { resolve: (v: unknown) => void },
  capabilityReads: 0,
  otpSends: 0,
  initialUrl: null as string | null,
  qrReads: [] as string[],
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const kids = (children: unknown) =>
    (typeof children === 'function' ? (children as (s: { pressed: boolean }) => unknown)({ pressed: false }) : children) as React.ReactNode;
  const View = ({ children, testID, accessibilityLabel }: any) =>
    R.createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, kids(children));
  const Pressable = ({ children, onPress, disabled, accessibilityLabel, accessibilityHint, testID }: any) => R.createElement('div', {
    role: 'button', 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint, 'aria-disabled': disabled ? 'true' : undefined,
    'data-testid': testID, onClick: disabled ? undefined : () => onPress?.(),
  }, kids(children));
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, KeyboardAvoidingView: View, Pressable, Image: () => null, ActivityIndicator: () => null,
    TextInput: ({ value, placeholder, testID }: any) => R.createElement('input', { value: value ?? '', placeholder, 'data-testid': testID, readOnly: true }),
    Modal: ({ visible, children }: any) => (visible ? R.createElement('div', null, children) : null),
    StatusBar: () => null,
    Platform: { get OS() { return fx.os; }, select: (options: any) => options[fx.os] ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, absoluteFillObject: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 375, height: 667 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 375, height: 667, fontScale: 1, scale: 2 }),
    Keyboard: { addListener: () => ({ remove() {} }), dismiss: () => undefined }, Vibration: { vibrate: () => undefined, cancel: () => undefined },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Linking: { openURL: async () => undefined, getInitialURL: async () => fx.initialUrl, addEventListener: () => ({ remove() {} }) },
    Alert: { alert: () => undefined }, TurboModuleRegistry: { get: () => null },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    PanResponder: { create: () => ({ panHandlers: {} }) },
  };
});
vi.mock('react-native-reanimated', async () => {
  const R = await import('react');
  const makeSV = (initial: number) => {
    const sv = {
      raw: initial,
      current: null as Anim | null,
      get value() { return sv.raw; },
      set value(next: any) {
        if (next && typeof next === 'object' && next.__anim) {
          if (sv.current && !sv.current.settled) { sv.current.settled = true; sv.current.cb?.(false); }
          const anim: Anim = { ...next, sv, startedAt: fx.now, settled: false };
          sv.current = anim;
          fx.anims.push(anim);
        } else sv.raw = next;
      },
    };
    return sv;
  };
  return {
    __esModule: true,
    default: { View: ({ children, testID }: any) => R.createElement('div', { 'data-testid': testID }, children) },
    Easing: { bezier: () => ({}) },
    Extrapolation: { CLAMP: 'clamp' },
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    interpolate: () => 0,
    runOnJS: (fn: (...args: unknown[]) => void) => (...args: unknown[]) => fn(...args),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => fx.reduced,
    useSharedValue: (initial: number) => R.useState(() => makeSV(initial))[0],
    withDelay: (delay: number, anim: any) => ({ ...anim, delay: anim.delay + delay }),
    withTiming: (to: number, config?: any, cb?: (finished?: boolean) => void) => ({ __anim: true, to, delay: 0, duration: config?.duration ?? 300, cb }),
  };
});
vi.mock('expo-splash-screen', () => ({ setOptions: (options: unknown) => { fx.splashOptions.push(options); } }));
vi.mock('@react-navigation/elements', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const SafeAreaProviderCompat = Object.assign(Box, { initialMetrics: { frame: { width: 375, height: 667 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } } });
  return {
    SafeAreaProviderCompat, Screen: Box, Header: () => null, HeaderBackButton: () => null,
    HeaderBackContext: R.createContext(undefined), HeaderShownContext: R.createContext(false),
    HeaderHeightContext: R.createContext(0), useHeaderHeight: () => 0,
    getHeaderTitle: (_options: unknown, name: string) => name, getLabel: (options: any, fallback: string) => options.label ?? fallback,
    PlatformPressable: Box, Label: Box, Background: Box, Badge: () => null, MissingIcon: () => null,
    useFrameSize: () => ({ width: 375, height: 667 }), useLocale: () => ({ direction: 'ltr' }),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const R = await import('react');
  const insets = { top: 20, bottom: 0, left: 0, right: 0 };
  return { SafeAreaInsetsContext: R.createContext(insets), useSafeAreaInsets: () => insets, SafeAreaProvider: ({ children }: any) => children };
});
vi.mock('react-native-screens', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { screensEnabled: () => false, Screen: Box, ScreenContainer: Box };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: Object.assign(() => null, { glyphMap: {} }) }));
vi.mock('@swift/ui', () => {
  const token: unknown = new Proxy({}, { get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, radius: token, space: token, font: token, fontSize: token, typeScale: token, withAlpha: () => '' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `welcome-doors-fixture-${++next}` }; });
vi.mock('../lib/storage', () => ({
  zustandStorage: {
    getItem: (key: string) => fx.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fx.storage.set(key, value); },
    removeItem: (key: string) => { fx.storage.delete(key); },
  },
}));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope: () => undefined }));
vi.mock('../lib/analytics', () => ({ track: () => undefined }));
vi.mock('../lib/haptics', () => ({ haptic: { select: () => undefined, light: () => undefined } }));
vi.mock('../kit/toast', () => ({ toast: { show: () => undefined, success: () => undefined, info: () => undefined, error: () => undefined } }));
// The transport: the welcome's only read is the ads switch. It is held open (no network) unless a test answers it.
// A scanned table QR is the other read: the real link router asks which store the code is.
vi.mock('../services/api', () => ({
  api: {
    get: (url: string) => {
      if (url.startsWith('/public/qr/')) {
        fx.qrReads.push(url);
        return Promise.resolve({ data: { success: true, data: { verdict: 'WEB_RENDER', vendorId: 'vendor-table-qr' } } });
      }
      if (url !== '/public/capabilities') throw new Error(`unexpected read ${url}`);
      fx.capabilityReads += 1;
      return new Promise((resolve) => { fx.capability = { resolve }; });
    },
    post: async () => ({ data: { success: true } }),
  },
  authApi: { sendOtp: async () => { fx.otpSends += 1; return { data: { success: true } }; } },
}));
vi.mock('../services/push', () => ({ registerIfGranted: async () => undefined, installPushForegroundRetry: () => () => undefined }));
vi.mock('../services/attribution', () => ({ ensureFirstLaunchClaim: () => undefined, flushAttributedDestination: () => undefined }));
vi.mock('../services/notification-router', () => ({
  installNotificationTapRouter: () => () => undefined, flushPendingNavigation: () => undefined, settleTapAfterSignIn: () => undefined,
}));
// The link router is the real one (services/deep-links): a table QR opens its store while the intro steps aside.
vi.mock('../hooks/useCustomerCountry', () => ({ useCustomerCountry: () => undefined }));
vi.mock('../components/LegalAcceptanceModal', () => ({ LegalAcceptanceModal: () => null }));
vi.mock('../modules/safety/OwnedSafetyPanel', () => ({ OwnedSafetyPanel: () => null }));
vi.mock('../kit/pressable-scale', async () => {
  const R = await import('react');
  return {
    PressableScale: ({ children, onPress, testID, accessibilityLabel, accessibilityHint }: any) =>
      R.createElement('div', { role: 'button', 'data-testid': testID, 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint, onClick: onPress }, children),
  };
});
vi.mock('../kit', async () => {
  const R = await import('react');
  const { View } = await import('react-native');
  return {
    T: ({ children }: any) => R.createElement('span', null, children),
    Screen: ({ children, testID }: any) => R.createElement(View as any, { testID }, children),
    Pictogram: () => null,
    PillButton: ({ label, onPress, disabled, testID }: any) => R.createElement('div', {
      role: 'button', 'aria-label': label, 'aria-disabled': disabled ? 'true' : undefined, 'data-testid': testID, onClick: disabled ? undefined : onPress,
    }, label),
    LabeledInput: ({ value, placeholder, testID }: any) => R.createElement('input', { placeholder, value: value ?? '', 'data-testid': testID, readOnly: true }),
  };
});
vi.mock('../components/SwiftLogo', () => ({ SwiftMark: () => null, SwiftWordmark: () => null }));
// The apps behind the doors: each says which app it is.
vi.mock('./CustomerStack', async () => {
  const R = await import('react');
  return { CustomerStack: () => R.createElement('section', { 'data-screen': 'customer-app' }, 'Swift home') };
});
vi.mock('../modules/mover/MoverStack', async () => {
  const R = await import('react');
  return { MoverStack: () => R.createElement('section', { 'data-screen': 'driver-app' }, 'Driver app') };
});
vi.mock('../modules/vendor/VendorStack', async () => {
  const R = await import('react');
  return { VendorStack: () => R.createElement('section', { 'data-screen': 'business-app' }, 'Business app') };
});
vi.mock('../modules/advertiser/AdvertiserStack', () => ({ AdvertiserStack: () => null }));
vi.mock('../screens/auth/OtpVerificationScreen', () => ({ OtpVerificationScreen: () => null }));
vi.mock('../screens/auth/RegisterScreen', () => ({ RegisterScreen: () => null }));
vi.mock('../screens/auth/SelfieCaptureScreen', () => ({ SelfieCaptureScreen: () => null }));
vi.mock('../screens/auth/SessionHoldScreen', () => ({ SessionHoldScreen: () => null }));
vi.mock('../screens/QrOutcomeScreen', () => ({ QrOutcomeScreen: () => null }));
vi.mock('../screens/OpsAlertsScreen', () => ({ OpsAlertsScreen: () => null }));

import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { queryClient } from '../lib/queryClient';
import { INTRO_TIMELINE } from '../lib/launchIntro';
import { LaunchIntro } from '../components/LaunchIntro';
import { WELCOME_DOORS } from '../screens/auth/RolePickerScreen';
import { navigationRef } from './navigationRef';
import { RootNavigator } from './RootNavigator';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let commits = 0;
const text = () => host.textContent ?? '';
async function settle(ms = 120) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }

/** Open the app as App.tsx does once the encrypted stores are open: the navigator, then the intro over it. */
async function launch() {
  await act(async () => root.render(React.createElement(React.Profiler, { id: 'app', onRender: () => { commits += 1; } },
    React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(RootNavigator),
      React.createElement(LaunchIntro)))));
  await settle();
}

/** The UI thread runs `ms` of frames. */
async function frames(ms: number) {
  const target = fx.now + ms;
  for (;;) {
    const due = fx.anims
      .filter((a) => !a.settled && a.startedAt + a.delay + a.duration <= target)
      .sort((a, b) => (a.startedAt + a.delay + a.duration) - (b.startedAt + b.delay + b.duration))[0];
    if (!due) break;
    fx.now = due.startedAt + due.delay + due.duration;
    await act(async () => { due.settled = true; due.sv.raw = due.to; due.cb?.(true); });
  }
  fx.now = target;
}
const playIntro = () => frames(Math.max(0, ...fx.anims.map((a) => a.startedAt + a.delay + a.duration - fx.now)));

const intro = () => host.querySelector('[data-testid="launch-intro"]');
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rootRoute = () => { const s = navigationRef.getRootState(); return s?.routes[s.index]?.name; };
const currentRoute = () => navigationRef.getCurrentRoute()?.name;
async function tap(id: string) {
  const el = byTestId(id);
  if (!el) throw new Error(`no ${id} on screen: ${text()}`);
  await act(async () => { el.click(); });
  await settle();
}

/** The welcome, with the intro over (first launch) and then gone. */
async function welcomeAfterIntro() {
  await launch();
  expect(intro()).not.toBeNull();
  await playIntro();
  expect(intro()).toBeNull();
  expect(byTestId('role-picker-screen')).not.toBeNull();
}

beforeEach(() => {
  Object.assign(fx, { os: 'ios', now: 0, anims: [], reduced: false, splashOptions: [], capability: null, capabilityReads: 0, otpSends: 0, initialUrl: null, qrReads: [] });
  fx.storage.clear();
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useAppStore.setState({ hasSeenIntro: false });
  commits = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe('[APP-INTRO] first launch, signed out: intro → welcome', () => {
  it('the intro covers a welcome that is already there; when it leaves, the four doors and Sign in are in view', async () => {
    await launch();
    expect(intro()).not.toBeNull();
    expect(rootRoute()).toBe('RolePicker');
    // Underneath, from the first frame: nothing mounts when the intro leaves.
    for (const door of WELCOME_DOORS) expect(byTestId(`role-picker-${door.key}`), door.title).not.toBeNull();
    expect(byTestId('role-picker-sign-in')).not.toBeNull();
    expect(fx.splashOptions).toEqual([{ duration: 0, fade: false }]);

    await playIntro();
    expect(intro()).toBeNull();
    expect(text()).toContain('Welcome to Swift');
    expect(WELCOME_DOORS.map((d) => d.title)).toEqual(['Order with Swift', 'Sell on Swift', 'Deliver with Swift', 'Drive with Swift']);
    for (const door of WELCOME_DOORS) {
      const el = byTestId(`role-picker-${door.key}`)!;
      expect(el.getAttribute('aria-label')).toBe(`${door.title}. ${door.sub}`);
      expect(el.getAttribute('data-hint')).toBe(door.hint);
    }
    expect(useAppStore.getState().hasSeenIntro).toBe(true);
  });

  it('renders without the network and then settles: no re-render while idle', async () => {
    await launch();
    // The ads switch is the screen's only read, and it is still open: the doors did not wait for it.
    expect(fx.capabilityReads).toBe(1);
    expect(fx.capability).not.toBeNull();
    for (const door of WELCOME_DOORS) expect(byTestId(`role-picker-${door.key}`)).not.toBeNull();
    expect(byTestId('role-picker-advertiser')).toBeNull();

    const atMount = commits;
    // While the intro plays (UI thread only), nothing renders.
    await frames(INTRO_TIMELINE.full.reveal.delay);
    await settle(200);
    expect(commits, 'the intro playing re-rendered the app').toBe(atMount);

    await playIntro();
    const afterIntro = commits;
    expect(afterIntro - atMount, 'one commit: the intro leaving').toBe(1);

    // The ads switch answers (off, the launch state): at most one commit, and the doors do not move.
    await act(async () => { fx.capability!.resolve({ data: { success: true, data: { adsEnabled: false } } }); });
    await settle();
    expect(commits - afterIntro).toBeLessThanOrEqual(1);
    expect(byTestId('role-picker-advertiser')).toBeNull();

    // Idle: a full second of nothing. No loop anywhere on the welcome.
    const idle = commits;
    await settle(1000);
    expect(commits, 'the welcome re-rendered while idle').toBe(idle);
    expect(fx.anims.filter((a) => !a.settled)).toEqual([]);
  });
});

describe('[APP-INTRO] each door continues into the sign-up the app already had', () => {
  it('Order with Swift: the customer app, browsing as a guest (sign-in waits for checkout)', async () => {
    await welcomeAfterIntro();
    await tap('role-picker-customer');
    expect(rootRoute()).toBe('Main');
    expect(host.querySelector('[data-screen="customer-app"]')).not.toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ intent: 'customer', moverPreset: null, isAuthenticated: false, wantsAuth: false, countryCode: 'GY' });
    expect(intro()).toBeNull();
  });

  it.each([
    ['vendor', 'Sell on Swift', { intent: 'vendor', moverPreset: null }, 'Sign up as a business'],
    ['delivery', 'Deliver with Swift', { intent: 'mover', moverPreset: 'delivery' }, 'Sign up as a Swift driver'],
    ['taxi', 'Drive with Swift', { intent: 'mover', moverPreset: 'taxi' }, 'Sign up as a Swift driver'],
  ] as const)('%s (%s): the phone sign-up for that role', async (key, _title, role, framing) => {
    await welcomeAfterIntro();
    await tap(`role-picker-${key}`);
    expect(rootRoute()).toBe('Auth');
    expect(currentRoute()).toBe('PhoneEntry');
    expect(text()).toContain('Create your account');
    expect(text()).toContain(framing);
    expect(useAuthStore.getState()).toMatchObject({ ...role, isAuthenticated: false, countryCode: 'GY' });
    // No account is made and nothing is sent until they type a number and ask for the code.
    expect(fx.otpSends).toBe(0);

    // Never a one-way door: back to the welcome, with no intro replayed (it is not a launch).
    await tap('auth-back-to-welcome');
    expect(rootRoute()).toBe('RolePicker');
    expect(intro()).toBeNull();
    expect(useAuthStore.getState().intent).toBeNull();
  });

  it('Already have an account? Sign in: the phone sign-in, with no role asked', async () => {
    await welcomeAfterIntro();
    await tap('role-picker-sign-in');
    expect(rootRoute()).toBe('Auth');
    expect(currentRoute()).toBe('PhoneEntry');
    expect(text()).toContain('Sign in or sign up');
    expect(useAuthStore.getState()).toMatchObject({ intent: null, wantsAuth: true, isAuthenticated: false });
  });

  it('a stale preset from an earlier visit is cleared by a door that has none', async () => {
    useAuthStore.setState({ moverPreset: 'taxi' });
    await welcomeAfterIntro();
    await tap('role-picker-vendor');
    expect(useAuthStore.getState()).toMatchObject({ intent: 'vendor', moverPreset: null });
  });
});

describe('[APP-INTRO] the other launches', () => {
  it('signed in: straight to their app, no intro, the native splash untouched', async () => {
    useAuthStore.setState({
      isAuthenticated: true, accessToken: 'a', refreshToken: 'r', intent: 'customer',
      user: { id: 'u1', roles: ['CUSTOMER'], selfieCapturedAt: null } as never,
    });
    await launch();
    expect(intro()).toBeNull();
    expect(rootRoute()).toBe('Main');
    expect(host.querySelector('[data-screen="customer-app"]')).not.toBeNull();
    expect(fx.anims).toEqual([]);
    expect(fx.splashOptions).toEqual([]);
  });

  it('a guest who already chose Order with Swift: straight to Home, no intro', async () => {
    useAuthStore.setState({ intent: 'customer' });
    await launch();
    expect(intro()).toBeNull();
    expect(host.querySelector('[data-screen="customer-app"]')).not.toBeNull();
  });

  it('back on the welcome after seeing it once: the quick dissolve, then the doors', async () => {
    useAppStore.setState({ hasSeenIntro: true });
    await launch();
    expect(intro()).not.toBeNull();
    expect(fx.anims).toHaveLength(1);
    await frames(INTRO_TIMELINE.quick.reveal.duration);
    expect(intro()).toBeNull();
    expect(byTestId('role-picker-customer')).not.toBeNull();
  });

  it('Reduce Motion: a still brand frame, then the doors', async () => {
    fx.reduced = true;
    await launch();
    expect(intro()).not.toBeNull();
    expect(fx.anims, 'only the dissolve is scheduled').toHaveLength(1);
    await frames(INTRO_TIMELINE.still.reveal.delay + INTRO_TIMELINE.still.reveal.duration);
    expect(intro()).toBeNull();
    await tap('role-picker-taxi');
    expect(currentRoute()).toBe('PhoneEntry');
    expect(useAuthStore.getState()).toMatchObject({ intent: 'mover', moverPreset: 'taxi' });
  });

  it('a tap on the intro skips it: the doors are usable at once', async () => {
    await launch();
    await frames(100);
    await tap('launch-intro-skip');
    await frames(INTRO_TIMELINE.skip.duration);
    expect(intro()).toBeNull();
    await tap('role-picker-delivery');
    expect(currentRoute()).toBe('PhoneEntry');
    expect(useAuthStore.getState()).toMatchObject({ intent: 'mover', moverPreset: 'delivery' });
  });
});

describe('[APP-INTRO · review] a signed-out first open from a link', () => {
  it('a table QR: the intro steps aside at once and the store opens (the intro never plays over it)', async () => {
    fx.initialUrl = 'https://swiftgy.com/s/bcdfghjkmn';
    await launch();
    // The launch link resolved: the reveal was replaced by the skip, which ends 140 ms after launch.
    const cover = fx.anims.filter((a) => a.to === 0);
    expect(cover.map((a) => a.duration)).toEqual([INTRO_TIMELINE.full.reveal.duration, INTRO_TIMELINE.skip.duration]);
    await frames(INTRO_TIMELINE.skip.duration);
    await settle();
    expect(intro()).toBeNull();
    expect(fx.qrReads).toEqual(['/public/qr/BCDFGHJKMN']);
    expect(rootRoute()).toBe('Storefront');
    expect(host.querySelector('[data-screen="customer-app"]')).not.toBeNull();
    // Still signed out, no door picked: the store is public.
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, intent: null });
  });

  it('the development client\'s own link is not a store: the intro plays as usual', async () => {
    fx.initialUrl = 'swift://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081';
    await launch();
    expect(fx.anims.filter((a) => a.to === 0)).toHaveLength(1);
    await playIntro();
    expect(intro()).toBeNull();
    expect(rootRoute()).toBe('RolePicker');
    expect(fx.qrReads).toEqual([]);
  });
});

describe('[APP-INTRO] App.tsx composes it this way', () => {
  it('mounts the intro last inside the ready branch, after the navigator, so it covers everything', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const ready = app.slice(app.indexOf('<QueryClientProvider client={queryClient}>'), app.indexOf('</QueryClientProvider>'));
    expect(ready).toContain('<RootNavigator />');
    expect(ready.indexOf('<LaunchIntro />')).toBeGreaterThan(ready.indexOf('<RootNavigator />'));
    expect(ready.indexOf('<LaunchIntro />')).toBeGreaterThan(ready.indexOf('<UpdateRequiredGate />'));
    expect(ready.trimEnd().endsWith('<LaunchIntro />')).toBe(true);
    // Only once the encrypted stores are open (the recovery screen has no intro).
    expect(app).toMatch(/storageStatus === 'error' \? \([\s\S]*?<SecureStorageRecovery[\s\S]*?\) : \([\s\S]*?<LaunchIntro \/>/);
  });
});
