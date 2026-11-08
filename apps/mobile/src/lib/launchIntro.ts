// [APP-INTRO · owner 8 Nov 2026] "when you open uber they have a nice design … the logo and swift colour showing
// the screen, then after a second, but fast, not delayed, opens into the choose option … right now it looks like as
// soon as someone downloads, no intro, straight to sign up, it looks cheap."
//
// PURE: who sees the brand intro at launch, and its timeline. The overlay (components/LaunchIntro.tsx) reads these;
// the tests read them too, so the timing the owner was promised is pinned in one place.

export type IntroMode = 'full' | 'quick' | 'none';

export interface LaunchIntroState {
  isAuthenticated: boolean;
  /** "Sign in" was tapped this session; not persisted, so false at every cold start. */
  wantsAuth: boolean;
  /** The door already picked on this phone (customer browsing as a guest, or a partner sign-up under way). */
  intent: string | null;
  /** This phone has played the full intro before. */
  hasSeenIntro: boolean;
}

/**
 * The intro plays only when the app opens on the welcome screen, which is exactly the signed-out phone that has
 * not picked a door (rootEntryGate's 'role-picker'). Everyone else opens where they left off, as before:
 * - signed in: their own app, never the intro;
 * - a guest who already chose "Order with Swift": Home;
 * - a partner sign-up under way: their sign-up.
 *
 * Returning to the welcome (they closed the app before choosing, or signed out) gets the QUICK version: the logo
 * holds and the maroon dissolves into the welcome in under a third of a second. They have seen the brand once; a
 * second full second would be the "delayed" the owner ruled out, and a hard cut from maroon to paper is the
 * cheap look he wants gone.
 */
export function introModeAtLaunch(state: LaunchIntroState): IntroMode {
  if (state.isAuthenticated || state.wantsAuth || state.intent !== null) return 'none';
  return state.hasSeenIntro ? 'quick' : 'full';
}

/**
 * The timeline, in ms from the first frame (the frame identical to the native splash). Every value is run on the
 * UI thread by Reanimated (withDelay + withTiming); nothing here is a JS timer.
 *
 * FULL (~1.04 s): the logo eases up and settles smaller while the wordmark, then the tagline, rise in; a short beat
 * on the finished frame; then the maroon dissolves into the welcome as the brand grows slightly, so the screen
 * "opens into" the choice rather than switching to it.
 */
export const INTRO_TIMELINE = {
  full: {
    mark: { delay: 0, duration: 520 },
    wordmark: { delay: 160, duration: 380 },
    tagline: { delay: 260, duration: 380 },
    reveal: { delay: 780, duration: 260 },
  },
  /** Returning to the welcome: the logo holds, the maroon dissolves. */
  quick: { reveal: { delay: 0, duration: 280 } },
  /** Reduce Motion: the finished frame, still, for a beat; then a plain dissolve (no movement, no scaling). */
  still: { reveal: { delay: 500, duration: 200 } },
  /** Reduce Motion on a return visit: only the dissolve. */
  stillQuick: { reveal: { delay: 0, duration: 200 } },
  /** A tap anywhere skips: the maroon dissolves at once. */
  skip: { duration: 140 },
} as const;

export type IntroPlan = keyof Omit<typeof INTRO_TIMELINE, 'skip'>;

export function introPlan(mode: Exclude<IntroMode, 'none'>, reducedMotion: boolean): IntroPlan {
  if (reducedMotion) return mode === 'full' ? 'still' : 'stillQuick';
  return mode;
}

/** When the welcome is fully in view, in ms from the first frame. */
export function introEndsAtMs(plan: IntroPlan): number {
  const { reveal } = INTRO_TIMELINE[plan];
  return reveal.delay + reveal.duration;
}

/**
 * The one JS timer: a backstop, never a frame driver. If the UI-thread completion never reaches JS (the app was
 * backgrounded mid-intro and the OS dropped the frame callbacks, say), the overlay still leaves, so it can never
 * sit over the welcome screen.
 */
export const INTRO_BACKSTOP_GRACE_MS = 1500;

/**
 * The geometry of the native splash, which the intro's first frame repeats exactly: app.config.ts draws
 * assets/icon.png 140 pt wide ('contain') at the centre of the screen, on the same maroon. That icon is the mark at
 * 80% of its square, so the mark itself is 112 pt, centred.
 */
export const SPLASH_IMAGE_PT = 140;
export const SPLASH_MARK_PT = SPLASH_IMAGE_PT * 0.8;

/** Where the logo settles: lifted above centre and smaller, leaving room for the wordmark and tagline below. */
export const MARK_SETTLE = { lift: 44, scale: 0.64 } as const;
