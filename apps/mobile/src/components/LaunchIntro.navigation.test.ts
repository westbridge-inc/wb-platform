/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-INTRO · owner 8 Nov 2026] "the logo and swift colour showing the screen, then after a second, but fast, not
// delayed, opens into the choose option."
//
// Rendered with real React. Reanimated is a stand-in that keeps what the UI thread would run: every value assigned
// to a shared value (its target, delay, duration, easing, reduce-motion rule and completion), on a virtual clock the
// test advances. Nothing in the stand-in renders React, exactly like the real UI thread: so a commit counted by the
// Profiler while the clock runs is a render the INTRO caused, which is what "settles" has to rule out.
// ---------------------------------------------------------------------------

type Anim = {
  sv: SharedValue;
  to: number;
  delay: number;
  duration: number;
  easing: unknown;
  reduceMotion: unknown;
  delayReduceMotion: unknown;
  cb?: (finished?: boolean) => void;
  startedAt: number;
  settled: boolean;
  name: string;
};
type SharedValue = { name: string; raw: number; current: Anim | null; value: number };

const fx = vi.hoisted(() => ({
  now: 0,
  anims: [] as Anim[],
  reduced: false,
  setOptions: [] as unknown[],
  statusBars: [] as Array<{ barStyle?: string; mounted: boolean }>,
  storage: new Map<string, string>(),
  auth: { isAuthenticated: false, wantsAuth: false, intent: null as string | null },
  svCount: 0,
  svs: [] as SharedValue[],
  // The launch link (Linking.getInitialURL) and links arriving while the app is open.
  initialUrl: null as string | null,
  urlListeners: new Set<(event: { url: string }) => void>(),
  splashHides: 0,
  setOptionsThrows: false,
  markThrows: false,
  crashes: [] as Array<{ message: string; source: unknown }>,
  // [review 2] The screen reader's answer: given at once, or held until the test answers it (readerLate).
  readerOn: false,
  readerLate: false,
  answerReader: null as null | ((on: boolean) => void),
  // The animated props each Animated.View was given (by testID): their updaters run on the UI thread.
  animatedProps: new Map<string, { updater: () => Record<string, unknown> }>(),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const box = (tag: string) => ({ children, testID, style: _style, ...rest }: any) =>
    R.createElement('div', { 'data-host': tag, 'data-testid': testID, 'aria-label': rest.accessibilityLabel }, children);
  return {
    View: box('View'),
    Text: box('Text'),
    Pressable: ({ children, onPress, testID, accessibilityLabel, accessibilityHint, accessibilityRole, accessibilityViewIsModal }: any) =>
      R.createElement('div', {
        role: accessibilityRole, 'data-testid': testID, 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint,
        'data-modal': String(accessibilityViewIsModal), onClick: () => onPress?.(),
      }, children),
    AccessibilityInfo: {
      isScreenReaderEnabled: () => (fx.readerLate
        ? new Promise<boolean>((resolve) => { fx.answerReader = resolve; })
        : Promise.resolve(fx.readerOn)),
    },
    StatusBar: (props: { barStyle?: string }) => {
      R.useEffect(() => {
        const entry = { barStyle: props.barStyle, mounted: true };
        fx.statusBars.push(entry);
        return () => { entry.mounted = false; };
      }, []);
      return null;
    },
    StyleSheet: { create: (s: unknown) => s, absoluteFill: {} },
    Linking: {
      getInitialURL: async () => fx.initialUrl,
      addEventListener: (_event: 'url', fn: (event: { url: string }) => void) => {
        fx.urlListeners.add(fn);
        return { remove: () => { fx.urlListeners.delete(fn); } };
      },
    },
  };
});

vi.mock('react-native-reanimated', async () => {
  const R = await import('react');
  const settleOne = (a: Anim, finished: boolean) => {
    if (a.settled) return;
    a.settled = true;
    if (finished) a.sv.raw = a.to;
    a.cb?.(finished);
  };
  const makeSV = (initial: number): SharedValue => {
    const sv: SharedValue = {
      name: `sv${++fx.svCount}`,
      raw: initial,
      current: null,
      get value() { return sv.raw; },
      set value(next: any) {
        if (next && typeof next === 'object' && next.__anim) {
          // Assigning a new animation cancels the running one: its completion gets finished = false.
          if (sv.current) settleOne(sv.current, false);
          const anim: Anim = { ...next, sv, startedAt: fx.now, settled: false, name: sv.name };
          sv.current = anim;
          fx.anims.push(anim);
        } else {
          sv.raw = next;
        }
      },
    };
    fx.svs.push(sv);
    return sv;
  };
  return {
    __esModule: true,
    default: {
      View: ({ children, testID, animatedProps, accessibilityElementsHidden, importantForAccessibility }: any) => {
        if (testID && animatedProps) fx.animatedProps.set(testID, animatedProps);
        return R.createElement('div', {
          'data-host': 'Animated.View', 'data-testid': testID,
          'data-reader-hidden': accessibilityElementsHidden === undefined ? undefined : String(accessibilityElementsHidden),
          'data-important': importantForAccessibility,
        }, children);
      },
    },
    Easing: { bezier: (...points: number[]) => ({ bezier: points }) },
    Extrapolation: { CLAMP: 'clamp' },
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    interpolate: (v: number, input: number[], output: number[]) => {
      const t = Math.min(1, Math.max(0, (v - input[0]!) / (input[1]! - input[0]!)));
      return output[0]! + (output[1]! - output[0]!) * t;
    },
    runOnJS: (fn: (...args: unknown[]) => void) => (...args: unknown[]) => fn(...args),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    // Kept as the updater: the UI thread re-runs it on every frame; the test runs it to read what the UI thread sees.
    useAnimatedProps: (updater: () => Record<string, unknown>) => ({ updater }),
    useReducedMotion: () => fx.reduced,
    useSharedValue: (initial: number) => R.useState(() => makeSV(initial))[0],
    withDelay: (delay: number, anim: any, reduceMotion?: unknown) => ({ ...anim, delay: anim.delay + delay, delayReduceMotion: reduceMotion }),
    withTiming: (to: number, config?: any, cb?: (finished?: boolean) => void) => ({
      __anim: true, to, delay: 0, duration: config?.duration ?? 300, easing: config?.easing, reduceMotion: config?.reduceMotion, cb,
    }),
    // The intro never repeats: the stand-in has no withRepeat/withSequence, so using one would fail to render.
  };
});
vi.mock('expo-splash-screen', () => ({
  setOptions: (options: unknown) => {
    if (fx.setOptionsThrows) throw new Error('splash options unavailable');
    fx.setOptions.push(options);
  },
  hideAsync: async () => { fx.splashHides += 1; },
}));
vi.mock('../lib/crash-reporter', () => ({
  reportCrash: (error: Error, context?: { source?: unknown }) => { fx.crashes.push({ message: error.message, source: context?.source }); },
}));
vi.mock('../kit', async () => {
  const R = await import('react');
  return { T: ({ children }: any) => R.createElement('span', { 'data-host': 'T' }, children) };
});
vi.mock('./SwiftLogo', async () => {
  const R = await import('react');
  return {
    SwiftMark: (p: { size: number; tint?: string; accent?: string }) => {
      if (fx.markThrows) throw new Error('mark failed to draw');
      return R.createElement('div', { 'data-host': 'SwiftMark', 'data-size': p.size, 'data-tint': p.tint, 'data-accent': p.accent });
    },
    SwiftWordmark: (p: { height: number; tint?: string }) =>
      R.createElement('div', { 'data-host': 'SwiftWordmark', 'data-height': p.height, 'data-tint': p.tint }),
  };
});
vi.mock('../stores/authStore', () => ({ useAuthStore: { getState: () => fx.auth } }));
vi.mock('../lib/storage', () => ({
  zustandStorage: {
    getItem: (key: string) => fx.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fx.storage.set(key, value); },
    removeItem: (key: string) => { fx.storage.delete(key); },
  },
}));

import { color } from '@swift/ui';
import { INTRO_TAGLINE, LaunchIntro, resetLaunchIntroForTests } from './LaunchIntro';
import { ErrorBoundary } from './ErrorBoundary';
import { useAppStore } from '../stores/appStore';
import {
  INTRO_BACKSTOP_GRACE_MS, INTRO_BRAND_GONE_AT, INTRO_TIMELINE, SPLASH_IMAGE_PT, SPLASH_MARK_PT,
  introDecidedThisSession, markIntroDecided,
} from '../lib/launchIntro';
import { linkDecisionCounters, resetLinkDecisionsForTests } from '../lib/deepLinkParse';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let introCommits = 0;
let welcomeRenders = 0;

/** What sits under the intro in the app: the welcome screen, already rendered. */
function WelcomeUnderneath() {
  welcomeRenders += 1;
  return React.createElement('div', { 'data-testid': 'welcome' }, 'Welcome to Swift');
}

async function launch() {
  await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(WelcomeUnderneath),
    React.createElement(React.Profiler, { id: 'intro', onRender: () => { introCommits += 1; } }, React.createElement(LaunchIntro)),
  )));
}

/** The UI thread runs `ms` of frames: every animation whose end falls inside completes, in end order. */
async function frames(ms: number) {
  const target = fx.now + ms;
  for (;;) {
    const due = fx.anims
      .filter((a) => !a.settled && a.startedAt + a.delay + a.duration <= target)
      .sort((a, b) => (a.startedAt + a.delay + a.duration) - (b.startedAt + b.delay + b.duration))[0];
    if (!due) break;
    fx.now = due.startedAt + due.delay + due.duration;
    await act(async () => {
      due.settled = true;
      due.sv.raw = due.to;
      due.cb?.(true);
    });
  }
  fx.now = target;
  // JS-side timers (the backstop) see the same clock.
  await act(async () => { vi.advanceTimersByTime(ms); });
}

const intro = () => host.querySelector('[data-testid="launch-intro"]');
const welcome = () => host.querySelector('[data-testid="welcome"]');
const live = () => fx.anims.filter((a) => !a.settled);
/** The latest animation assigned to the shared value created at `index` (mark, wordmark, tagline, cover). */
const assignedTo = (index: number) => fx.anims.filter((a) => a.name === `sv${index}`);
const endOf = (a: Anim) => a.delay + a.duration;
/** The animations assigned to mark, wordmark, tagline and cover, in that order. */
const byValue = (): [Anim[], Anim[], Anim[], Anim[]] => [assignedTo(1), assignedTo(2), assignedTo(3), assignedTo(4)];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  Object.assign(fx, {
    now: 0, anims: [], reduced: false, setOptions: [], statusBars: [], svCount: 0, svs: [],
    initialUrl: null, splashHides: 0, setOptionsThrows: false, markThrows: false, crashes: [],
    readerOn: false, readerLate: false, answerReader: null,
  });
  fx.animatedProps.clear();
  // Every test is a fresh app session: the intro not yet decided, the screen reader asked (and answered: off).
  await resetLaunchIntroForTests();
  fx.urlListeners.clear();
  resetLinkDecisionsForTests();
  fx.auth = { isAuthenticated: false, wantsAuth: false, intent: null };
  fx.storage.clear();
  useAppStore.setState({ hasSeenIntro: false });
  introCommits = 0;
  welcomeRenders = 0;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe('[APP-INTRO] first launch, signed out: the splash continues into the brand, then the welcome', () => {
  it('opens on the native splash frame: the same maroon, the same white mark, the same size', async () => {
    await launch();
    // app.config.ts is the native splash: its colour and size are the intro's first frame, read from the source.
    const config = readFileSync(join(process.cwd(), 'app.config.ts'), 'utf8');
    expect(config).toMatch(/const brandMaroon = '#[0-9A-Fa-f]{6}';/);
    expect(config).toMatch(/const splashBackgroundColor = brandMaroon;/);
    expect(config).toMatch(/const splashImage = '\.\/assets\/icon\.png';/);
    expect(config).toMatch(/'expo-splash-screen',\s*\{\s*backgroundColor: splashBackgroundColor,\s*image: splashImage,\s*imageWidth: 140,\s*resizeMode: 'contain',/);
    expect(SPLASH_IMAGE_PT).toBe(140);
    // assets/icon.svg draws the mark at 80% of the square (translate(10,10) scale(0.8)).
    expect(readFileSync(join(process.cwd(), 'assets/icon.svg'), 'utf8')).toContain('<g transform="translate(10,10) scale(0.8)">');
    expect(SPLASH_MARK_PT).toBe(112);
    // [review] Android 12+ draws the same size. expo-splash-screen paints the image imageWidth dp wide at the centre
    // of a 288 dp transparent canvas, and sets no icon background, so the theme keeps core-splashscreen's 288 dp
    // no-background icon slot (240 dp is only with an icon background): the canvas is shown 1:1, the image at
    // 140 dp, the mark at 112 dp, and the slot's 192 dp visible circle clears the mark (65 dp at its farthest).
    const plugin = (file: string) => readFileSync(join(process.cwd(), 'node_modules/expo-splash-screen/plugin/build', file), 'utf8');
    expect(plugin('withAndroidSplashImages.js')).toContain('const size = imageWidth * multiplier;');
    expect(plugin('withAndroidSplashImages.js')).toContain('const canvasSize = 288 * multiplier;');
    expect(plugin('withAndroidSplashImages.js')).toContain('x: (canvasSize - size) / 2,');
    expect(plugin('withAndroidSplashStyles.js')).toContain("parent: 'Theme.SplashScreen'");
    expect(plugin('withAndroidSplashStyles.js')).not.toContain('windowSplashScreenIconBackgroundColor');
    // The token the intro paints is the colour the native splash paints.
    expect(color.brand[500]).toBe(/const brandMaroon = '(#[0-9A-Fa-f]{6})';/.exec(config)?.[1]);

    const src = readFileSync(join(process.cwd(), 'src/components/LaunchIntro.tsx'), 'utf8');
    expect(src).toContain('ground: { backgroundColor: color.brand[500] }');
    const mark = host.querySelector('[data-host="SwiftMark"]')!;
    expect(mark.getAttribute('data-size')).toBe(String(SPLASH_MARK_PT));
    expect(mark.getAttribute('data-tint')).toBe(color.white);
    expect(mark.getAttribute('data-accent')).toBe(color.white);
    // The first frame is the splash: the mark has not moved and the words are not yet there.
    // Shared values in creation order: mark, wordmark, tagline, cover.
    expect(fx.svs.map((sv) => sv.raw)).toEqual([0, 0, 0, 1]);
    // The native splash leaves at once (Android fades it by default), so the two marks never drift apart.
    expect(fx.setOptions).toEqual([{ duration: 0, fade: false }]);
    // White status-bar icons while the maroon is up.
    expect(fx.statusBars.filter((s) => s.mounted).map((s) => s.barStyle)).toEqual(['light-content']);
    // The welcome is ALREADY rendered underneath: nothing mounts when the intro leaves.
    expect(welcome()).not.toBeNull();
    expect(intro()).not.toBeNull();
    expect(host.textContent).toContain(INTRO_TAGLINE);
  });

  it('runs about a second on the UI thread: the mark settles, the wordmark and tagline arrive, the maroon dissolves', async () => {
    await launch();
    const [mark, word, tag, cover] = byValue();
    expect([mark, word, tag, cover].map((a) => a.length)).toEqual([1, 1, 1, 1]);
    expect(mark[0]).toMatchObject({ to: 1, ...INTRO_TIMELINE.full.mark });
    expect(word[0]).toMatchObject({ to: 1, ...INTRO_TIMELINE.full.wordmark });
    expect(tag[0]).toMatchObject({ to: 1, ...INTRO_TIMELINE.full.tagline });
    expect(cover[0]).toMatchObject({ to: 0, ...INTRO_TIMELINE.full.reveal });
    // The words arrive after the mark starts; the dissolve starts after everything has arrived.
    expect(word[0]!.delay).toBeGreaterThan(mark[0]!.delay);
    expect(tag[0]!.delay).toBeGreaterThan(word[0]!.delay);
    expect(cover[0]!.delay).toBeGreaterThanOrEqual(Math.max(...[mark, word, tag].map((a) => endOf(a[0]!))));
    // "after a second, but fast, not delayed": the welcome is in full view between 0.9 and 1.2 s.
    const total = Math.max(...fx.anims.map(endOf));
    expect(total).toBeGreaterThanOrEqual(900);
    expect(total).toBeLessThanOrEqual(1200);
    // Reduce Motion is the intro's own decision (below), never Reanimated's silent "skip the delay".
    for (const a of fx.anims) {
      expect(a.reduceMotion).toBe('never');
      expect(a.delayReduceMotion).toBe('never');
    }

    await frames(total - 1);
    expect(intro(), 'still dissolving at 1 ms before the end').not.toBeNull();
    await frames(1);
    expect(intro()).toBeNull();
    expect(welcome()).not.toBeNull();
    // The app's own (dark) status bar is back.
    expect(fx.statusBars.filter((s) => s.mounted)).toEqual([]);
    expect(useAppStore.getState().hasSeenIntro).toBe(true);
  });

  it('settles: one render to appear, none while it plays, one to leave, none after (no loop, no JS frame driver)', async () => {
    await launch();
    expect(introCommits).toBe(1);
    expect(welcomeRenders).toBe(1);

    // The whole timeline, in 10 ms steps short of the end: the UI thread animates, React is not involved.
    for (let t = 0; t < 1030; t += 10) await frames(10);
    expect(intro()).not.toBeNull();
    expect(introCommits, 'the intro re-rendered while it played').toBe(1);

    await frames(20);
    expect(intro()).toBeNull();
    expect(introCommits, 'one commit to leave').toBe(2);

    // Idle: a minute passes. Nothing renders, nothing is scheduled, nothing animates.
    await frames(60_000);
    expect(introCommits).toBe(2);
    expect(welcomeRenders, 'the welcome underneath never re-rendered').toBe(1);
    expect(vi.getTimerCount(), 'the backstop timer was cleared').toBe(0);
    expect(live()).toEqual([]);
  });

  it('a tap skips: the maroon dissolves at once and the welcome is in view', async () => {
    await launch();
    await frames(200);
    await act(async () => { (host.querySelector('[data-testid="launch-intro-skip"]') as HTMLElement).click(); });
    const cover = assignedTo(4);
    expect(cover).toHaveLength(2);
    expect(cover[0]!.settled, 'the scheduled reveal was cancelled').toBe(true);
    expect(cover[1]).toMatchObject({ to: 0, delay: 0, duration: INTRO_TIMELINE.skip.duration, reduceMotion: 'never' });

    // A second tap while it dissolves changes nothing that matters.
    await act(async () => { (host.querySelector('[data-testid="launch-intro-skip"]') as HTMLElement).click(); });
    await frames(INTRO_TIMELINE.skip.duration);
    expect(intro()).toBeNull();
    expect(welcome()).not.toBeNull();
    expect(useAppStore.getState().hasSeenIntro).toBe(true);
    expect(introCommits).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can never sit over the welcome: if the UI thread\'s "done" never reaches JS, a one-shot backstop removes it', async () => {
    await launch();
    // Drop every completion (an app backgrounded mid-intro, say): the clock runs, no callback arrives.
    for (const a of fx.anims) a.cb = undefined;
    const total = Math.max(...fx.anims.map(endOf));
    await act(async () => { vi.advanceTimersByTime(total + INTRO_BACKSTOP_GRACE_MS - 1); });
    expect(intro()).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(intro()).toBeNull();
    expect(useAppStore.getState().hasSeenIntro).toBe(true);
  });

  it('is announced as Swift and can be skipped by a screen reader', async () => {
    await launch();
    const skip = host.querySelector('[data-testid="launch-intro-skip"]')!;
    expect(skip.getAttribute('role')).toBe('button');
    expect(skip.getAttribute('aria-label')).toBe(`Swift. ${INTRO_TAGLINE}`);
    expect(skip.getAttribute('data-hint')).toBe('Skips the intro');
  });
});

describe('[APP-INTRO] Reduce Motion: a still frame, then go', () => {
  it('first launch: the finished brand frame, still, then a plain dissolve; nothing moves or scales', async () => {
    fx.reduced = true;
    await launch();
    const [mark, word, tag, cover] = byValue();
    // No movement is scheduled at all: the mark, wordmark and tagline are simply there.
    expect([mark, word, tag].map((a) => a.length)).toEqual([0, 0, 0]);
    expect(cover).toHaveLength(1);
    expect(cover[0]).toMatchObject({ to: 0, ...INTRO_TIMELINE.still.reveal, reduceMotion: 'never', delayReduceMotion: 'never' });
    // The still frame is the FINISHED one: mark settled, wordmark and tagline in (created at 1, never animated).
    expect(fx.svs.map((sv) => sv.raw)).toEqual([1, 1, 1, 1]);
    expect(host.querySelector('[data-host="SwiftWordmark"]')).not.toBeNull();

    await frames(INTRO_TIMELINE.still.reveal.delay + INTRO_TIMELINE.still.reveal.duration);
    expect(intro()).toBeNull();
    expect(welcome()).not.toBeNull();
    expect(introCommits).toBe(2);
    expect(useAppStore.getState().hasSeenIntro).toBe(true);
  });

  it('a return visit: only the dissolve', async () => {
    fx.reduced = true;
    useAppStore.setState({ hasSeenIntro: true });
    await launch();
    expect(fx.anims).toHaveLength(1);
    expect(fx.anims[0]).toMatchObject({ to: 0, ...INTRO_TIMELINE.stillQuick.reveal });
    await frames(INTRO_TIMELINE.stillQuick.reveal.duration);
    expect(intro()).toBeNull();
  });
});

describe('[APP-INTRO] who sees it', () => {
  it('a return to the welcome (seen before) gets the quick version: the logo holds, the maroon dissolves', async () => {
    useAppStore.setState({ hasSeenIntro: true });
    await launch();
    expect(intro()).not.toBeNull();
    expect(fx.anims).toHaveLength(1);
    expect(fx.anims[0]).toMatchObject({ to: 0, ...INTRO_TIMELINE.quick.reveal });
    expect(INTRO_TIMELINE.quick.reveal.duration).toBeLessThan(350);
    await frames(INTRO_TIMELINE.quick.reveal.duration);
    expect(intro()).toBeNull();
    expect(introCommits).toBe(2);
  });

  it.each([
    ['signed in', { isAuthenticated: true, wantsAuth: false, intent: 'customer' }],
    ['signed in as a partner', { isAuthenticated: true, wantsAuth: false, intent: 'mover' }],
    ['a guest who already chose Order with Swift', { isAuthenticated: false, wantsAuth: false, intent: 'customer' }],
    ['a partner sign-up under way', { isAuthenticated: false, wantsAuth: false, intent: 'vendor' }],
  ])('%s: nothing at all (their app opens as before, the native splash fades as before)', async (_who, auth) => {
    fx.auth = auth;
    await launch();
    expect(intro()).toBeNull();
    expect(fx.anims).toEqual([]);
    expect(fx.setOptions, 'the native splash keeps its own exit').toEqual([]);
    expect(fx.statusBars).toEqual([]);
    expect(introCommits).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(useAppStore.getState().hasSeenIntro).toBe(false);
  });
});

describe('[APP-INTRO · review] a throw in the intro never leaves the splash up or the app blocked', () => {
  it.each<[string, () => void, string]>([
    ['the native splash options', () => { fx.setOptionsThrows = true; }, 'splash options unavailable'],
    ['its own drawing', () => { fx.markThrows = true; }, 'mark failed to draw'],
  ])('%s throws: the intro is left out, the welcome is in view, the splash is hidden, the crash is reported', async (_what, arm, message) => {
    arm();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await launch();
    quiet.mockRestore();
    expect(intro()).toBeNull();
    expect(welcome(), 'the app underneath is untouched').not.toBeNull();
    // React retries a render that threw once, synchronously, then stops: at most one extra render, and none after.
    expect(welcomeRenders).toBeLessThanOrEqual(2);
    const settled = welcomeRenders;
    await frames(2000);
    expect(welcomeRenders).toBe(settled);
    expect(fx.splashHides).toBe(1);
    expect(fx.crashes).toEqual([{ message, source: 'launch-intro' }]);
    expect(vi.getTimerCount(), 'no backstop left behind').toBe(0);
    expect(fx.urlListeners.size).toBe(0);
  });
});

describe('[APP-INTRO · review] opened by a link: the intro steps aside at once', () => {
  async function linkSettles() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

  it.each([
    ['a table QR (short code)', 'https://swiftgy.com/s/bcdfghjkmn'],
    ['a shared store', 'https://swiftgy.com/store/green-bowl-x7k2m9?c=bcdfghjkmn'],
    ['the app\'s own scheme', 'swift://s/BCDFGHJKMN'],
    ['the weekly-fee return', 'swift://pay/mmg/return'],
    ['the card fee return', 'swift://pay/card/return'],
  ])('%s at launch', async (_what, url) => {
    fx.initialUrl = url;
    await launch();
    await linkSettles();
    const cover = assignedTo(4);
    expect(cover, 'the reveal was replaced by the skip').toHaveLength(2);
    expect(cover[0]!.settled).toBe(true);
    expect(cover[1]).toMatchObject({ to: 0, delay: 0, duration: INTRO_TIMELINE.skip.duration });
    await frames(INTRO_TIMELINE.skip.duration);
    expect(intro()).toBeNull();
    expect(welcome()).not.toBeNull();
    // It only peeks: the router counts the link once, when it opens it.
    expect(linkDecisionCounters()).toEqual({ accepted: {}, rejected: {} });
    expect(fx.urlListeners.size, 'the listener left with the intro').toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a link that arrives while it plays', async () => {
    await launch();
    await linkSettles();
    await frames(300);
    expect(assignedTo(4)).toHaveLength(1);
    await act(async () => { for (const fn of [...fx.urlListeners]) fn({ url: 'https://swiftgy.com/s/bcdfghjkmn' }); });
    expect(assignedTo(4)).toHaveLength(2);
    await frames(INTRO_TIMELINE.skip.duration);
    expect(intro()).toBeNull();
  });

  it.each([
    ['no link', null],
    ['the development client', 'swift://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'],
    ['another site', 'https://attacker.example/s/BCDFGHJKMN'],
    ['a page that is not a store', 'https://swiftgy.com/about'],
  ])('%s: the intro plays as usual', async (_what, url) => {
    fx.initialUrl = url;
    await launch();
    await linkSettles();
    expect(assignedTo(4)).toHaveLength(1);
    const total = Math.max(...fx.anims.map(endOf));
    await frames(total - 1);
    expect(intro()).not.toBeNull();
    await frames(1);
    expect(intro()).toBeNull();
  });
});

describe('[APP-INTRO · review] the brand leaves before the welcome shows through', () => {
  it('the white brand is gone while the maroon is still three-quarters up', () => {
    expect(INTRO_BRAND_GONE_AT).toBeGreaterThanOrEqual(0.75);
    const src = readFileSync(join(process.cwd(), 'src/components/LaunchIntro.tsx'), 'utf8');
    expect(src).toContain('opacity: interpolate(cover.value, [INTRO_BRAND_GONE_AT, 1], [0, 1], Extrapolation.CLAMP),');
  });
});

// ---------------------------------------------------------------------------
// [APP-INTRO · review 2] Three small findings from the second independent review.
// ---------------------------------------------------------------------------

/** What the UI thread would hand the overlay right now: whether it takes touches. */
const touchesNow = () => fx.animatedProps.get('launch-intro')!.updater()['pointerEvents'];

describe('[APP-INTRO · review 2] once per app session: a remount never replays the intro', () => {
  it('after it played, the same session remounting the app (no cold start) shows no intro', async () => {
    await launch();
    expect(introDecidedThisSession()).toBe(true);
    await frames(1040);
    expect(intro()).toBeNull();

    // The whole tree again, in the same process (what "Try again" and the storage retry do).
    await act(async () => root.unmount());
    root = createRoot(host);
    fx.anims = [];
    fx.setOptions = [];
    await launch();
    expect(intro()).toBeNull();
    expect(welcome()).not.toBeNull();
    expect(fx.anims, 'nothing animates').toEqual([]);
    expect(fx.setOptions, 'the splash options are not touched again').toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a remount while it is still playing does not start it over', async () => {
    await launch();
    await frames(300);
    await act(async () => root.unmount());
    root = createRoot(host);
    fx.anims = [];
    await launch();
    expect(intro()).toBeNull();
    expect(fx.anims).toEqual([]);
    // It never finished, so the next cold start (a new session) still plays the full intro once.
    expect(useAppStore.getState().hasSeenIntro).toBe(false);
  });

  it('the crash screen\'s "Try again": the welcome comes back, the intro does not', async () => {
    const boom = { on: false };
    function CrashesOnDemand() {
      if (boom.on) throw new Error('welcome crashed');
      return null;
    }
    const app = () => React.createElement(ErrorBoundary, null,
      React.createElement(WelcomeUnderneath), React.createElement(CrashesOnDemand), React.createElement(LaunchIntro));
    await act(async () => root.render(app()));
    expect(intro()).not.toBeNull();
    await frames(1040);
    expect(intro()).toBeNull();

    // A signed-out user on the welcome hits a crash.
    boom.on = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => root.render(app()));
    quiet.mockRestore();
    expect(host.textContent).toContain('Something went wrong');

    boom.on = false;
    fx.anims = [];
    await act(async () => { (host.querySelector('[role="button"]') as HTMLElement).click(); });
    expect(welcome()).not.toBeNull();
    expect(intro(), 'no maroon replay after Try again').toBeNull();
    expect(fx.anims).toEqual([]);
  });

  it('a crash before the intro ever mounted: the splash is gone, so "Try again" opens with no intro', async () => {
    const boom = { on: true };
    function CrashesFirst() {
      if (boom.on) throw new Error('first render failed');
      return null;
    }
    const app = () => React.createElement(ErrorBoundary, null, React.createElement(CrashesFirst), React.createElement(LaunchIntro));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => root.render(app()));
    quiet.mockRestore();
    expect(host.textContent).toContain('Something went wrong');
    expect(introDecidedThisSession(), 'the crash screen decided it').toBe(true);
    boom.on = false;
    await act(async () => { (host.querySelector('[role="button"]') as HTMLElement).click(); });
    expect(intro()).toBeNull();
    expect(fx.anims).toEqual([]);
  });

  it('"Unlock Swift to continue": the storage recovery decided it, so the intro never flashes over the app', async () => {
    // App.tsx marks it when the recovery screen shows (that screen hides the native splash) ...
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).toMatch(/catch \(error\) \{[\s\S]*?markIntroDecided\(\);\s*setStorageStatus\('error'\);/);
    // ... so when the retry opens the stores and the intro mounts for the first time, it renders nothing.
    markIntroDecided();
    await launch();
    expect(intro()).toBeNull();
    expect(welcome()).not.toBeNull();
    expect(fx.anims).toEqual([]);
    expect(fx.setOptions).toEqual([]);
  });
});

describe('[APP-INTRO · review 2] a screen reader never loses its place', () => {
  it('reader on at launch: hidden from the reader (focus goes to the welcome), only the short dissolve', async () => {
    fx.readerOn = true;
    await resetLaunchIntroForTests();
    await launch();
    const overlay = intro()!;
    expect(overlay.getAttribute('data-reader-hidden')).toBe('true');
    expect(overlay.getAttribute('data-important')).toBe('no-hide-descendants');
    const skip = host.querySelector('[data-testid="launch-intro-skip"]')!;
    expect(skip.getAttribute('data-modal'), 'never traps the reader on a button about to vanish').toBe('false');
    // The short plan, like Reduce Motion on a return visit: nothing moves, one quick dissolve.
    expect(fx.anims).toHaveLength(1);
    expect(fx.anims[0]).toMatchObject({ to: 0, ...INTRO_TIMELINE.stillQuick.reveal });
    await frames(INTRO_TIMELINE.stillQuick.reveal.duration);
    expect(intro()).toBeNull();
    expect(welcome()).not.toBeNull();
  });

  it('reader off: the intro is a button the reader can skip, as before', async () => {
    await launch();
    expect(intro()!.getAttribute('data-reader-hidden')).toBe('false');
    expect(intro()!.getAttribute('data-important')).toBe('auto');
    expect(host.querySelector('[data-testid="launch-intro-skip"]')!.getAttribute('data-modal')).toBe('true');
  });

  it('the reader answers after the first frame: the intro hides from it and steps aside at once', async () => {
    fx.readerLate = true;
    void resetLaunchIntroForTests();
    await launch();
    expect(intro()!.getAttribute('data-reader-hidden')).toBe('false');
    expect(assignedTo(4)).toHaveLength(1);
    await frames(100);
    await act(async () => { fx.answerReader!(true); await Promise.resolve(); });
    expect(intro()!.getAttribute('data-reader-hidden')).toBe('true');
    const cover = assignedTo(4);
    expect(cover, 'the reveal was replaced by the skip').toHaveLength(2);
    expect(cover[1]).toMatchObject({ to: 0, delay: 0, duration: INTRO_TIMELINE.skip.duration });
    await frames(INTRO_TIMELINE.skip.duration);
    expect(intro()).toBeNull();
  });

  it('a late "off" changes nothing: no extra render, the intro plays as usual', async () => {
    fx.readerLate = true;
    void resetLaunchIntroForTests();
    await launch();
    await act(async () => { fx.answerReader!(false); await Promise.resolve(); });
    expect(introCommits).toBe(1);
    expect(assignedTo(4)).toHaveLength(1);
    await frames(1040);
    expect(intro()).toBeNull();
  });
});

describe('[APP-INTRO · review 2] the overlay never holds touches once it is visually gone', () => {
  it('takes touches while the maroon is up; lets them through the moment it is gone, even if "done" is lost', async () => {
    await launch();
    expect(touchesNow()).toBe('auto');
    // Drop every completion: the UI thread finishes the dissolve, JS never hears about it.
    for (const a of fx.anims) a.cb = undefined;
    await frames(1039);
    expect(touchesNow(), 'mid-dissolve: still the intro (a tap skips)').toBe('auto');
    await frames(1);
    // The maroon is gone; JS's backstop has not fired, so the overlay is still mounted, but it takes no touches.
    expect(intro()).not.toBeNull();
    expect(touchesNow()).toBe('none');
    // The backstop still tidies it away.
    await act(async () => { vi.advanceTimersByTime(INTRO_BACKSTOP_GRACE_MS); });
    expect(intro()).toBeNull();
  });

  it('the same after a tap-skip whose completion is lost', async () => {
    await launch();
    await frames(200);
    await act(async () => { (host.querySelector('[data-testid="launch-intro-skip"]') as HTMLElement).click(); });
    for (const a of fx.anims) a.cb = undefined;
    expect(touchesNow()).toBe('auto');
    await frames(INTRO_TIMELINE.skip.duration);
    expect(intro()).not.toBeNull();
    expect(touchesNow()).toBe('none');
  });
});
