/** @jsxImportSource react */
import React, { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Linking, Pressable, StatusBar, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  Extrapolation,
  ReduceMotion,
  interpolate,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';
import { color, space } from '@swift/ui';
import { T } from '../kit';
import { SwiftMark, SwiftWordmark } from './SwiftLogo';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { reportCrash } from '../lib/crash-reporter';
import { linkOpensAScreen } from '../lib/deepLinkParse';
import {
  INTRO_BACKSTOP_GRACE_MS,
  INTRO_BRAND_GONE_AT,
  INTRO_TIMELINE,
  MARK_SETTLE,
  SPLASH_MARK_PT,
  introDecidedThisSession,
  introEndsAtMs,
  introModeAtLaunch,
  introPlan,
  markIntroDecided,
  resetIntroSessionForTests,
  type IntroMode,
  type IntroPlan,
} from '../lib/launchIntro';

// [APP-INTRO · owner 8 Nov 2026] The brand intro: the native splash, continued. Its first frame IS the splash (the
// same maroon, the same white mark at the same size and place), so there is no seam when the native splash leaves.
// Then the mark eases up and settles smaller while the wordmark and the tagline rise in, and the maroon dissolves
// into the welcome screen, which has been rendered underneath from the first frame. About a second; a tap skips.
//
// It sits over the whole app, above the navigator, only on the launch that opens the welcome screen
// (lib/launchIntro.ts). Every frame runs on the UI thread (Reanimated); the component renders once and then only
// once more, to leave. No loop, no JS timer driving frames.

/** The website's own line (swiftgy.com's front page headline). */
export const INTRO_TAGLINE = 'Food, groceries, shops, couriers and rides.';
/** The wordmark's height: ascender to descender, about the settled mark's visible height. */
const WORDMARK_PT = 38;

const NEVER = ReduceMotion.Never; // Reduce Motion is handled by the plan itself (a still frame), never by skipping a delay.
/** Slow out of the splash frame (the first frames barely move, so the hand-off is invisible), soft landing. */
const EASE_MOVE = Easing.bezier(0.45, 0, 0.2, 1);
/** motion.easing.standard: the kit's arrival curve. */
const EASE_ARRIVE = Easing.bezier(0.2, 0, 0, 1);
const EASE_REVEAL = Easing.bezier(0.4, 0, 0.6, 1);
const LIFT = MARK_SETTLE.lift;
const SETTLED_SCALE = MARK_SETTLE.scale;
/** The brand grows this much while it dissolves, so the welcome opens out of it. */
const REVEAL_GROW = 1.05;

// [APP-INTRO · review 2] Is a screen reader on? Asked once, as the app loads (well before the encrypted stores open
// and the intro mounts), so the intro normally knows at its first frame. Never throws: no answer counts as "off".
let screenReaderOn: boolean | null = null;
let screenReaderAnswer: Promise<boolean> = askScreenReader();
function askScreenReader(): Promise<boolean> {
  screenReaderOn = null;
  return Promise.resolve()
    .then(() => AccessibilityInfo.isScreenReaderEnabled())
    .then(
      (on) => (screenReaderOn = on === true),
      () => (screenReaderOn = false),
    );
}

/** Tests only: a fresh app session (the intro not yet decided, the screen reader asked again). */
export function resetLaunchIntroForTests(): Promise<boolean> {
  resetIntroSessionForTests();
  screenReaderAnswer = askScreenReader();
  return screenReaderAnswer;
}

/**
 * Mounted once the encrypted stores are open (App.tsx), above everything. Fenced off: anything the intro throws
 * (its render, the splash options, a store read) leaves the intro out and the app as it was, never the app's own
 * error screen over a native splash that would then never be hidden (the root's onLayout would not run).
 */
export function LaunchIntro() {
  return (
    <IntroBoundary>
      <LaunchIntroGate />
    </IntroBoundary>
  );
}

class IntroBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    reportCrash(error, { componentStack: info?.componentStack, source: 'launch-intro' });
    markIntroDecided();
    // The rest of the tree still lays out and hides the splash; this is belt and braces.
    SplashScreen.hideAsync().catch(() => {});
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Decides once per app session, from the launch state. [review 2] A remount later in the same session (the crash
 * screen's "Try again", the storage recovery's retry) renders nothing: the splash it continues is long gone.
 */
function LaunchIntroGate() {
  const [mode, setMode] = useState<IntroMode>(() => {
    if (introDecidedThisSession()) return 'none';
    const auth = useAuthStore.getState();
    return introModeAtLaunch({
      isAuthenticated: auth.isAuthenticated,
      wantsAuth: auth.wantsAuth,
      intent: auth.intent,
      hasSeenIntro: useAppStore.getState().hasSeenIntro,
    });
  });
  // Marked once committed (not in the initializer, which React may run and throw away).
  useLayoutEffect(() => {
    markIntroDecided();
  }, []);
  const firstTime = mode === 'full';
  const finish = useCallback(() => {
    if (firstTime) useAppStore.getState().markIntroSeen();
    setMode('none');
  }, [firstTime]);
  if (mode === 'none') return null;
  return <BrandIntro mode={mode} onDone={finish} />;
}

function BrandIntro({ mode, onDone }: { mode: Exclude<IntroMode, 'none'>; onDone: () => void }) {
  const reducedMotion = useReducedMotion();
  // [review 2] With a screen reader on, the intro hides itself from the reader (its focus goes straight to the
  // welcome underneath, never to a button that is about to vanish) and takes only the short dissolve.
  const [readerOn, setReaderOn] = useState(() => screenReaderOn === true);
  // Fixed for this launch: a setting changed mid-intro does not restart it.
  const [plan] = useState<IntroPlan>(() => introPlan(mode, reducedMotion, readerOn));
  // Reduce Motion's first visit shows the FINISHED frame, still; every other plan starts on the splash frame.
  const startBuilt = plan === 'still' ? 1 : 0;
  const mark = useSharedValue(startBuilt);
  const wordmark = useSharedValue(startBuilt);
  const tagline = useSharedValue(startBuilt);
  const cover = useSharedValue(1);

  const doneRef = useRef(false);
  const done = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [onDone]);

  // The native splash leaves at once instead of fading (Android fades it over 400 ms by default): this frame is
  // the splash, so a fade would only show two logos drifting apart. Before App's first layout hides it.
  useLayoutEffect(() => {
    SplashScreen.setOptions({ duration: 0, fade: false });
  }, []);

  useEffect(() => {
    if (plan === 'full') {
      const t = INTRO_TIMELINE.full;
      mark.value = withDelay(
        t.mark.delay,
        withTiming(1, { duration: t.mark.duration, easing: EASE_MOVE, reduceMotion: NEVER }),
        NEVER,
      );
      wordmark.value = withDelay(
        t.wordmark.delay,
        withTiming(1, { duration: t.wordmark.duration, easing: EASE_ARRIVE, reduceMotion: NEVER }),
        NEVER,
      );
      tagline.value = withDelay(
        t.tagline.delay,
        withTiming(1, { duration: t.tagline.duration, easing: EASE_ARRIVE, reduceMotion: NEVER }),
        NEVER,
      );
    }
    const { reveal } = INTRO_TIMELINE[plan];
    cover.value = withDelay(
      reveal.delay,
      withTiming(0, { duration: reveal.duration, easing: EASE_REVEAL, reduceMotion: NEVER }, (finished) => {
        'worklet';
        if (finished) runOnJS(done)();
      }),
      NEVER,
    );
    // A backstop, not a frame driver: the overlay can never outstay its timeline.
    const backstop = setTimeout(done, introEndsAtMs(plan) + INTRO_BACKSTOP_GRACE_MS);
    return () => clearTimeout(backstop);
    // Runs once: the plan and the shared values are fixed for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = useCallback(() => {
    if (doneRef.current) return;
    // Replacing the reveal cancels it (its callback gets finished = false and does nothing).
    cover.value = withTiming(
      0,
      { duration: INTRO_TIMELINE.skip.duration, easing: EASE_REVEAL, reduceMotion: NEVER },
      (finished) => {
        'worklet';
        if (finished) runOnJS(done)();
      },
    );
  }, [cover, done]);

  // [review 2] The reader's answer came after the first frame (rare: it is asked as the app loads): step aside now.
  useEffect(() => {
    if (screenReaderOn !== null) return;
    let live = true;
    void screenReaderAnswer.then((on) => {
      if (!live || !on) return;
      setReaderOn(true);
      skip();
    });
    return () => {
      live = false;
    };
  }, [skip]);

  // [APP-INTRO · review] Opened by a link (a table QR, a shared store, the weekly-fee return): the screen it opens
  // is the point, so the intro steps aside at once, for the launch link and for one that arrives while it plays.
  useEffect(() => {
    let live = true;
    const opensAScreen = (url: string | null) => {
      if (live && linkOpensAScreen(url)) skip();
    };
    const sub = Linking.addEventListener('url', ({ url }) => opensAScreen(url));
    Linking.getInitialURL().then(opensAScreen).catch(() => undefined);
    return () => {
      live = false;
      sub.remove();
    };
  }, [skip]);

  const veil = useAnimatedStyle(() => ({ opacity: cover.value }));
  // [review 2] Touches go through to the welcome the moment the maroon is gone, decided on the UI thread from the
  // same value that draws it. JS "done" (or its backstop) then only removes an overlay nobody can see or touch.
  const touch = useAnimatedProps<{ pointerEvents: 'auto' | 'none' }>(() => ({
    pointerEvents: cover.value > 0 ? 'auto' : 'none',
  }));
  // While the maroon lifts, the white brand leaves first (growing slightly as it goes), gone while the maroon is
  // still three-quarters up, so the welcome's own words never show through a white logo.
  const grow = useAnimatedStyle(() => ({
    opacity: interpolate(cover.value, [INTRO_BRAND_GONE_AT, 1], [0, 1], Extrapolation.CLAMP),
    transform: [
      { scale: plan === 'full' ? interpolate(cover.value, [0, 1], [REVEAL_GROW, 1], Extrapolation.CLAMP) : 1 },
    ],
  }));
  const markStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(mark.value, [0, 1], [0, -LIFT], Extrapolation.CLAMP) },
      { scale: interpolate(mark.value, [0, 1], [1, SETTLED_SCALE], Extrapolation.CLAMP) },
    ],
  }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordmark.value,
    transform: [{ translateY: interpolate(wordmark.value, [0, 1], [12, 0], Extrapolation.CLAMP) }],
  }));
  const tagStyle = useAnimatedStyle(() => ({
    opacity: tagline.value,
    transform: [{ translateY: interpolate(tagline.value, [0, 1], [10, 0], Extrapolation.CLAMP) }],
  }));

  return (
    <Animated.View
      testID="launch-intro"
      style={[StyleSheet.absoluteFill, styles.ground, veil]}
      animatedProps={touch}
      accessibilityElementsHidden={readerOn}
      importantForAccessibility={readerOn ? 'no-hide-descendants' : 'auto'}
    >
      {/* White status-bar icons on the maroon; the app's dark ones return when the intro leaves. */}
      <StatusBar barStyle="light-content" />
      <Pressable
        testID="launch-intro-skip"
        style={StyleSheet.absoluteFill}
        onPress={skip}
        accessibilityRole="button"
        accessibilityLabel={`Swift. ${INTRO_TAGLINE}`}
        accessibilityHint="Skips the intro"
        accessibilityViewIsModal={!readerOn}
      >
        <Animated.View style={[StyleSheet.absoluteFill, styles.centre, grow]}>
          {/* The splash's mark: centred, SPLASH_MARK_PT square, white on maroon. */}
          <Animated.View style={[styles.mark, markStyle]}>
            <SwiftMark size={SPLASH_MARK_PT} tint={color.white} accent={color.white} />
          </Animated.View>
          <View style={styles.below} pointerEvents="none">
            <Animated.View style={wordStyle}>
              <SwiftWordmark height={WORDMARK_PT} tint={color.white} />
            </Animated.View>
            <Animated.View style={[styles.tagline, tagStyle]}>
              <T variant="body" tone="onBrand" center style={styles.taglineText}>
                {INTRO_TAGLINE}
              </T>
            </Animated.View>
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // app.config.ts's splash backgroundColor: the same maroon, so the first frame matches.
  ground: { backgroundColor: color.brand[500] },
  centre: { alignItems: 'center', justifyContent: 'center' },
  mark: { width: SPLASH_MARK_PT, height: SPLASH_MARK_PT },
  // From the screen's centre down: the wordmark sits just under the settled mark, the tagline under it.
  below: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    marginTop: space.xs,
    alignItems: 'center',
    paddingHorizontal: space['2xl'],
  },
  tagline: { marginTop: space.md, maxWidth: 360 },
  taglineText: { opacity: 0.86 },
});
