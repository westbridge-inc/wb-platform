import { afterEach, describe, expect, it, vi } from 'vitest';
import { installOtaCatchUp, otaSignedIn, type OtaCatchUpNative } from './otaCatchUp';
import { LAUNCH_WINDOW_MS } from '../lib/otaCatchUp';

// [OTA-CATCH-UP] The wiring: expo-updates' own state (an update downloaded = isUpdatePending), the app going away
// and coming back, the screen in front, and a sign-in. Native pieces are fakes with the real shapes.
function fakeNative(over: { isEnabled?: boolean } = {}) {
  const fx = {
    context: { isUpdatePending: false, isRestarting: false } as Record<string, unknown>,
    updateListeners: new Set<() => void>(),
    appState: null as null | ((s: string) => void),
    navListeners: new Set<() => void>(),
    route: null as string | null,
    mutating: 0,
    inCall: false,
    reloads: 0,
    checks: 0,
    removed: [] as string[],
  };
  const native: OtaCatchUpNative = {
    Updates: {
      isEnabled: over.isEnabled ?? true,
      get latestContext() { return fx.context as never; },
      reloadAsync: async () => { fx.reloads += 1; },
      checkForUpdateAsync: async () => { fx.checks += 1; return { isAvailable: false } as never; },
      fetchUpdateAsync: async () => ({}) as never,
      addUpdatesStateChangeListener: (cb: () => void) => { fx.updateListeners.add(cb); return { remove: () => { fx.updateListeners.delete(cb); fx.removed.push('updates'); } }; },
    } as unknown as OtaCatchUpNative['Updates'],
    AppState: { addEventListener: ((_: string, cb: (s: string) => void) => { fx.appState = cb; return { remove: () => fx.removed.push('appState') }; }) as never },
    isMutating: () => fx.mutating,
    inAppCallActive: () => fx.inCall,
    navigation: {
      isReady: () => fx.route !== null,
      getCurrentRoute: () => (fx.route ? { name: fx.route } : undefined),
      addListener: (_: 'state', cb: () => void) => { fx.navListeners.add(cb); return () => { fx.navListeners.delete(cb); fx.removed.push('nav'); }; },
    },
  };
  const downloaded = () => { fx.context = { ...fx.context, isUpdatePending: true }; for (const cb of [...fx.updateListeners]) cb(); };
  const navigate = (route: string) => { fx.route = route; for (const cb of [...fx.navListeners]) cb(); };
  return { fx, native, downloaded, navigate };
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

describe('installOtaCatchUp', () => {
  it('an update downloaded right after launch restarts the app into it (a fresh install never stays on its build-time JS)', () => {
    const { fx, native, downloaded } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    expect(fx.reloads).toBe(0);
    downloaded();
    expect(fx.reloads).toBe(1);
  });

  it('the store case: downloaded during sign-in, applied when the signed-in store reaches its orders board', () => {
    vi.useFakeTimers();
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    navigate('PhoneEntry');
    vi.advanceTimersByTime(LAUNCH_WINDOW_MS + 30_000);
    downloaded();
    navigate('OtpVerification');
    otaSignedIn('vendor');
    expect(fx.reloads).toBe(0);
    navigate('Orders');
    expect(fx.reloads).toBe(1);
  });

  it('a customer sign-in (maybe mid-checkout) opens no window', () => {
    vi.useFakeTimers();
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    navigate('Cart');
    vi.advanceTimersByTime(LAUNCH_WINDOW_MS + 30_000);
    downloaded();
    otaSignedIn('customer');
    navigate('Home');
    expect(fx.reloads).toBe(0);
  });

  it('never during an in-app call or while a write is on its way', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    navigate('Orders');
    fx.inCall = true;
    downloaded();
    expect(fx.reloads).toBe(0);
    fx.inCall = false;
    fx.mutating = 1;
    navigate('Orders');
    expect(fx.reloads).toBe(0);
    fx.mutating = 0;
    navigate('Orders');
    expect(fx.reloads).toBe(1);
  });

  it('back after a while away: asks the update server (the launch asked natively)', async () => {
    vi.useFakeTimers();
    const { fx, native } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    vi.advanceTimersByTime(30 * 60_000);
    fx.appState!('background');
    vi.advanceTimersByTime(5 * 60_000);
    fx.appState!('active');
    await Promise.resolve();
    expect(fx.checks).toBe(1);
  });

  it('off in development, where updates are off, or when the native module is missing; installed once; removable', () => {
    const dev = fakeNative();
    expect(installOtaCatchUp(() => dev.native, true)()).toBeUndefined();
    expect(dev.fx.updateListeners.size).toBe(0);
    const off = fakeNative({ isEnabled: false });
    installOtaCatchUp(() => off.native, false);
    expect(off.fx.updateListeners.size).toBe(0);
    installOtaCatchUp(() => { throw new Error('no native module'); }, false);
    const on = fakeNative();
    stop = installOtaCatchUp(() => on.native, false);
    const again = fakeNative();
    installOtaCatchUp(() => again.native, false); // a second install is a no-op
    expect(again.fx.updateListeners.size).toBe(0);
    stop();
    stop = null;
    expect(on.fx.removed.sort()).toEqual(['appState', 'nav', 'updates']);
  });
});
