/** @jsxImportSource react */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  Extrapolation,
  ReduceMotion,
  interpolate,
  runOnJS,
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
import {
  INTRO_BACKSTOP_GRACE_MS,
  INTRO_TIMELINE,
  MARK_SETTLE,
  SPLASH_MARK_PT,
  introEndsAtMs,
  introModeAtLaunch,
  introPlan,
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
/** The white brand is gone when the maroon is half lifted. */
const BRAND_GONE_AT = 0.5;

/** Mounted once the encrypted stores are open (App.tsx), above everything; decides once, from the launch state. */
export function LaunchIntro() {
  const [mode, setMode] = useState<IntroMode>(() => {
    const auth = useAuthStore.getState();
    return introModeAtLaunch({
      isAuthenticated: auth.isAuthenticated,
      wantsAuth: auth.wantsAuth,
      intent: auth.intent,
      hasSeenIntro: useAppStore.getState().hasSeenIntro,
    });
  });
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
  // Fixed for this launch: a setting changed mid-intro does not restart it.
  const [plan] = useState<IntroPlan>(() => introPlan(mode, reducedMotion));
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

  const veil = useAnimatedStyle(() => ({ opacity: cover.value }));
  // While the maroon lifts, the white brand leaves in the first half of it (growing slightly as it goes), so the
  // welcome's own words never show through a white logo.
  const grow = useAnimatedStyle(() => ({
    opacity: interpolate(cover.value, [BRAND_GONE_AT, 1], [0, 1], Extrapolation.CLAMP),
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
    <Animated.View testID="launch-intro" style={[StyleSheet.absoluteFill, styles.ground, veil]}>
      {/* White status-bar icons on the maroon; the app's dark ones return when the intro leaves. */}
      <StatusBar barStyle="light-content" />
      <Pressable
        testID="launch-intro-skip"
        style={StyleSheet.absoluteFill}
        onPress={skip}
        accessibilityRole="button"
        accessibilityLabel={`Swift. ${INTRO_TAGLINE}`}
        accessibilityHint="Skips the intro"
        accessibilityViewIsModal
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
