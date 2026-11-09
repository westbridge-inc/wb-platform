import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESTART_SCREEN_BACKGROUND, installOtaCatchUp, otaSignedIn, type OtaCatchUpNative } from './otaCatchUp';
import { LAUNCH_WINDOW_MS, SETTLE_MS, holdOtaRestart, resetOtaHoldsForTests } from '../lib/otaCatchUp';

// [OTA-CATCH-UP] The wiring: expo-updates' own state (an update downloaded = isUpdatePending), the app going away
// and coming back, the screen in front, and a sign-in. Native pieces are fakes with the real shapes.
function fakeNative(over: { isEnabled?: boolean } = {}) {
  const fx = {
    context: { isUpdatePending: false, isRestarting: false } as Record<string, unknown>,
    updateListeners: new Set<(event: { context: Record<string, unknown> }) => void>(),
    appState: null as null | ((s: string) => void),
    current: 'active',
    tap: false,
    link: false,
    tracked: [] as Array<[string, Record<string, string>]>,
    reloadOptions: [] as unknown[],
    navListeners: new Set<() => void>(),
    route: null as string | null,
    mutating: 0,
    inCall: false,
    ringing: false,
    focused: false,
    found: { isAvailable: false, isRollBackToEmbedded: false } as Record<string, boolean>,
    fetches: 0,
    reloads: 0,
    checks: 0,
    removed: [] as string[],
  };
  const native: OtaCatchUpNative = {
    Updates: {
      isEnabled: over.isEnabled ?? true,
      get latestContext() { return fx.context as never; },
      updateId: 'aaaaaaaa-1111-2222-3333-444444444444',
      reloadAsync: async (options?: unknown) => { fx.reloads += 1; fx.reloadOptions.push(options); },
      checkForUpdateAsync: async () => { fx.checks += 1; return fx.found as never; },
      fetchUpdateAsync: async () => { fx.fetches += 1; return {} as never; },
      addUpdatesStateChangeListener: (cb: (event: { context: Record<string, unknown> }) => void) => { fx.updateListeners.add(cb); return { remove: () => { fx.updateListeners.delete(cb); fx.removed.push('updates'); } }; },
    } as unknown as OtaCatchUpNative['Updates'],
    AppState: {
      get currentState() { return fx.current as never; },
      addEventListener: ((_: string, cb: (s: string) => void) => { fx.appState = (st) => { fx.current = st; cb(st); }; return { remove: () => fx.removed.push('appState') }; }) as never,
    },
    tapRoutingBusy: () => fx.tap,
    deepLinkBusy: () => fx.link,
    track: (event, properties) => { fx.tracked.push([event, properties]); },
    splashImage: 7,
    isMutating: () => fx.mutating,
    inAppCallActive: () => fx.inCall,
    inAppCallRinging: () => fx.ringing,
    inputFocused: () => fx.focused,
    navigation: {
      isReady: () => fx.route !== null,
      getCurrentRoute: () => (fx.route ? { name: fx.route } : undefined),
      addListener: (_: 'state', cb: () => void) => { fx.navListeners.add(cb); return () => { fx.navListeners.delete(cb); fx.removed.push('nav'); }; },
    },
  };
  const downloaded = (manifestId = 'bbbbbbbb-5555-6666-7777-888888888888') => {
    fx.context = { ...fx.context, isUpdatePending: true, downloadedManifest: { id: manifestId } };
    for (const cb of [...fx.updateListeners]) cb({ context: fx.context });
  };
  const navigate = (route: string) => { fx.route = route; for (const cb of [...fx.navListeners]) cb(); };
  return { fx, native, downloaded, navigate };
}

let stop: (() => void) | null = null;
/** The launch (or return) settle passes. */
const settle = () => vi.advanceTimersByTime(SETTLE_MS);
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  stop?.();
  stop = null;
  resetOtaHoldsForTests();
  vi.useRealTimers();
});

describe('installOtaCatchUp', () => {
  it('an update downloaded right after launch restarts the app into it (a fresh install never stays on its build-time JS)', () => {
    const { fx, native, downloaded } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    expect(fx.reloads).toBe(0);
    settle();
    downloaded();
    expect(fx.reloads).toBe(1);
  });

  it('the store case: downloaded during sign-in, applied when the signed-in store reaches its orders board', () => {
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
    settle();
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

// [REVIEW-1 on #2431] Never cut the store's new-order alert (S3-1), a call still ringing (S3-2) or text being typed
// (L1); a roll-back to the built-in JS is fetched like an update (L2).
describe('installOtaCatchUp: what must never be cut', () => {
  it('the store\'s new-order alert is up on the board: no restart; it closes inside the window: restart then', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    settle();
    navigate('Orders');
    const release = holdOtaRestart(); // VendorLiveOrderLayer, while the takeover shows
    downloaded();
    navigate('Orders');
    expect(fx.reloads).toBe(0);
    release();
    expect(fx.reloads).toBe(1);
  });

  it('an in-app call still ringing (not answered yet): no restart', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    settle();
    navigate('Orders');
    fx.ringing = true;
    downloaded();
    navigate('Orders');
    expect(fx.reloads).toBe(0);
    fx.ringing = false;
    navigate('Orders');
    expect(fx.reloads).toBe(1);
  });

  it('a text box has the keyboard: no restart', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    settle();
    navigate('Home');
    fx.focused = true;
    downloaded();
    expect(fx.reloads).toBe(0);
    fx.focused = false;
    navigate('Home');
    expect(fx.reloads).toBe(1);
  });

  it('a hold released outside any window does not restart', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    navigate('Orders');
    const release = holdOtaRestart();
    downloaded();
    vi.advanceTimersByTime(LAUNCH_WINDOW_MS + 1);
    release();
    expect(fx.reloads).toBe(0);
  });

  it('back after a while away: a roll-back to the built-in JS is fetched like a newer update', async () => {
    const { fx, native } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    fx.found = { isAvailable: false, isRollBackToEmbedded: true };
    vi.advanceTimersByTime(30 * 60_000);
    fx.appState!('background');
    vi.advanceTimersByTime(5 * 60_000);
    fx.appState!('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.checks).toBe(1);
    expect(fx.fetches).toBe(1);
  });

  it('nothing new on the server: nothing is fetched', async () => {
    const { fx, native } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    vi.advanceTimersByTime(30 * 60_000);
    fx.appState!('background');
    vi.advanceTimersByTime(5 * 60_000);
    fx.appState!('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.checks).toBe(1);
    expect(fx.fetches).toBe(0);
  });
});

describe('the holds are taken where the review asked', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('the store\'s new-order alert, a typed MMG reference and the reject question hold restarts', () => {
    expect(read('src/modules/vendor/VendorStack.tsx')).toMatch(/useOtaRestartHold\(takeover\.length > 0\);\n\s*return takeover\.length > 0 \? <NewOrderTakeover/);
    const board = read('src/modules/vendor/screens/VendorOps.tsx');
    expect(board).toMatch(/const \[mmgRef, setMmgRef\] = useState\(''\);\n[^\n]*\n\s*useOtaRestartHold\(mmgRef\.trim\(\)\.length > 0\);/);
    expect(board).toMatch(/useOtaRestartHold\(rejecting !== null\);/);
  });
  it('the store alert shown in another app holds restarts', () => {
    expect(read('src/components/StoreAlertElsewhere.tsx')).toMatch(/useOtaRestartHold\(alert !== null && intent !== 'vendor' && ownsStore\);/);
  });
  it('the real wiring reads a ringing call, a focused text box, taps and links, the holds and "active"', () => {
    const svcSrc = read('src/services/otaCatchUp.ts');
    expect(svcSrc).toMatch(/active: \(\) => AppState\.currentState === 'active'/);
    expect(svcSrc).toMatch(/native\.tapRoutingBusy\(\) \|\| native\.deepLinkBusy\(\)/);
    expect(svcSrc).toMatch(/tapRoutingBusy: \(\) => \(require\('\.\/notification-router'\)[^\n]*\.tapRoutingBusy\(\)/);
    expect(svcSrc).toMatch(/deepLinkBusy: \(\) => \(require\('\.\/deep-links'\)[^\n]*\.deepLinkBusy\(\)/);
    const svc = read('src/services/otaCatchUp.ts');
    expect(svc).toMatch(/inAppCallRinging: \(\) => \(require\('\.\/inAppVoice'\)[^\n]*\.inAppCallRinging\(\)/);
    expect(svc).toMatch(/currentlyFocusedInput\?\.\(\) != null/);
    expect(svc).toMatch(/native\.inAppCallRinging\(\) \|\| native\.isMutating\(\) > 0 \|\| otaRestartHeld\(\)/);
  });
});

// [REVIEW-2 S2-1 on #2431] Never in the background (a call that woke a closed app, a lock-screen answer, Android JS
// still running after the person left).
describe('installOtaCatchUp: only on the screen', () => {
  it('the app is not "active" (woken in the background by a call): no restart; on the screen inside a window: restart', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    fx.current = 'background';
    stop = installOtaCatchUp(() => native, false);
    navigate('Home');
    settle();
    downloaded();
    navigate('Home');
    expect(fx.reloads).toBe(0);
    fx.current = 'active';
    navigate('Home');
    expect(fx.reloads).toBe(1);
  });
});

// [REVIEW-2 S3-1 on #2431] After a return the app lets the tap, the link or the alert land first.
describe('installOtaCatchUp: a return settles first', () => {
  const away = (fx: ReturnType<typeof fakeNative>['fx']) => {
    fx.appState!('background');
    vi.advanceTimersByTime(5 * 60_000);
    fx.appState!('active');
  };

  it('back on the board with an update downloaded earlier: no restart on "active"; one after the settle', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    navigate('Orders');
    vi.advanceTimersByTime(LAUNCH_WINDOW_MS + 1);
    downloaded(); // after its own window
    away(fx);
    navigate('Orders');
    expect(fx.reloads).toBe(0);
    settle();
    expect(fx.reloads).toBe(1);
  });

  it('a notification tap lands inside the settle: no restart', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    navigate('Home');
    vi.advanceTimersByTime(LAUNCH_WINDOW_MS + 1);
    downloaded();
    away(fx);
    vi.advanceTimersByTime(500);
    fx.tap = true;
    settle();
    expect(fx.reloads).toBe(0);
  });

  it('a Swift link (a table QR) is landing: no restart', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    navigate('Home');
    vi.advanceTimersByTime(LAUNCH_WINDOW_MS + 1);
    downloaded();
    away(fx);
    fx.link = true;
    settle();
    expect(fx.reloads).toBe(0);
  });

  it('left again inside the settle: no restart', () => {
    const { fx, native, downloaded, navigate } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    navigate('Home');
    vi.advanceTimersByTime(LAUNCH_WINDOW_MS + 1);
    downloaded();
    away(fx);
    vi.advanceTimersByTime(1_000);
    fx.appState!('background');
    settle();
    expect(fx.reloads).toBe(0);
  });
});

// [REVIEW-2 L2/L3/info on #2431]
describe('installOtaCatchUp: how the restart looks and is counted', () => {
  it('the restart screen is Swift\'s splash (brand maroon, the icon); one ota_catch_up event names both JS ids', () => {
    const { fx, native, downloaded } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    settle();
    downloaded('cccccccc-9999-0000-1111-222222222222');
    expect(fx.reloadOptions).toEqual([{ reloadScreenOptions: { backgroundColor: RESTART_SCREEN_BACKGROUND, image: 7, imageResizeMode: 'contain', fade: true } }]);
    expect(fx.tracked).toEqual([['ota_catch_up', { from: 'aaaaaaaa-1111-2222-3333-444444444444', to: 'cccccccc-9999-0000-1111-222222222222' }]]);
  });

  it('the restart screen colour is the app\'s own splash colour', () => {
    const config = readFileSync(join(process.cwd(), 'app.config.ts'), 'utf8');
    expect(config).toMatch(new RegExp(`const brandMaroon = '${RESTART_SCREEN_BACKGROUND}';`));
    expect(config).toMatch(/const splashBackgroundColor = brandMaroon;/);
    expect(config).toMatch(/const splashImage = '\.\/assets\/icon\.png';/);
    expect(readFileSync(join(process.cwd(), 'src/services/otaCatchUp.ts'), 'utf8')).toMatch(/splashImage: require\('\.\.\/\.\.\/assets\/icon\.png'\)/);
  });

  it('"downloaded" is read from the state-change event itself, not only latestContext', () => {
    const { fx, native } = fakeNative();
    stop = installOtaCatchUp(() => native, false);
    settle();
    for (const cb of [...fx.updateListeners]) cb({ context: { isUpdatePending: true } }); // latestContext still says no
    expect(fx.reloads).toBe(1);
  });
});
