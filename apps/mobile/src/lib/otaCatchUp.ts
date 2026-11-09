// ---------------------------------------------------------------------------
// [OTA-CATCH-UP · 9 Nov 2026] A phone runs the newest over-the-air update, not
// the JavaScript it was built with, from the first launch on.
//
// Why: launch never waits on the network (owner decision 4: app.config
// `fallbackToCacheTimeout: 0`), so expo-updates starts the embedded or cached
// bundle at once and only DOWNLOADS a newer update; before this, the update
// applied on the next cold start. A store iPad installed from the App Store on
// 9 Nov ran build 12's embedded JS (cut 21 Oct, before the O-2 hand-overs):
// it asked for a pickup code the customer, rightly, was never given.
//
// What: once an update is downloaded (pending), the app restarts into it at a
// moment that cuts nothing — and only then:
// - a window is open: just launched, just back after a while away, or a store
//   just signed in (a mover's or advertiser's sign-in opens one too, but their
//   first screens are not resting ones, so it never restarts them: a mover's
//   offer card is never cut);
// - the screen in front is a resting one (customer home, the role doors, the
//   store's orders board) or no screen is up yet;
// - nothing is in flight or half-done: no in-app call (answered or still
//   ringing), no write on its way, no text being typed, and nothing holding the
//   screen (the store's new-order alert, a reference typed on the board).
// A foreground after a while away also asks the update server (at most every
// 30 minutes), so a phone that is never closed still catches up.
//
// Pure: no React, no native module (services/otaCatchUp.ts wires it).
// ---------------------------------------------------------------------------

/** After launch, a downloaded update may still apply for this long. */
export const LAUNCH_WINDOW_MS = 15_000;
/** After an earner signs in (the store's or mover's front door). */
export const SIGN_IN_WINDOW_MS = 60_000;
/** After the app comes back from a while away. */
export const RETURN_WINDOW_MS = 15_000;
/** "A while away": shorter trips (a glance at a message) never restart the app. */
export const AWAY_MS = 60_000;
/** The update server is asked again on a return at most this often (launch asks natively). */
export const CHECK_EVERY_MS = 30 * 60_000;

/** The resting screens: nothing typed or half-done is lost by a restart there. */
export const REST_ROUTES: readonly string[] = ['Home', 'RolePicker', 'Orders'];

// ─── Holds [REVIEW-1 S3-1/L1 on #2431] ─────────────────────────────────────────
// A screen part that must not be cut takes a hold while it is up (the store's
// new-order alert, a typed MMG reference, the reject question). Releasing the
// last hold lets the catch-up look again (inside its window only).
const holds = new Set<symbol>();
const releaseListeners = new Set<() => void>();

/** Holds restarts until the returned release is called (idempotent). */
export function holdOtaRestart(): () => void {
  const hold = Symbol('ota-hold');
  holds.add(hold);
  return () => {
    if (!holds.delete(hold) || holds.size > 0) return;
    for (const l of [...releaseListeners]) { try { l(); } catch { /* one listener never stops the rest */ } }
  };
}
/** Is anything holding restarts now? */
export function otaRestartHeld(): boolean {
  return holds.size > 0;
}
/** Called when the last hold is released. Returns the unsubscribe. */
export function onOtaHoldsReleased(listener: () => void): () => void {
  releaseListeners.add(listener);
  return () => { releaseListeners.delete(listener); };
}
/** Tests only. */
export function resetOtaHoldsForTests(): void {
  holds.clear();
  releaseListeners.clear();
}

export interface OtaCatchUpDeps {
  now(): number;
  /** An update is downloaded and waits for a restart. */
  pending(): boolean;
  /** Something the person is doing must not be cut (an in-app call, a write on its way). */
  busy(): boolean;
  /** The screen in front; null before the first screen is up. */
  route(): string | null;
  /** Restart into the downloaded update. */
  reload(): Promise<void>;
  /** Ask the update server, and download a newer update if there is one. */
  checkAndFetch(): Promise<void>;
}

export interface OtaCatchUp {
  /** Restarts now when every condition holds; true when it did. */
  evaluate(): boolean;
  /** An earner just signed in. */
  earnerSignedIn(): boolean;
  backgrounded(): void;
  foregrounded(): boolean;
}

export function createOtaCatchUp(deps: OtaCatchUpDeps): OtaCatchUp {
  let windowEnds = deps.now() + LAUNCH_WINDOW_MS;
  // The native launch check (checkAutomatically ON_LOAD) has just asked.
  let lastCheck = deps.now();
  let awaySince: number | null = null;
  let restarting = false;

  const open = (ms: number) => { windowEnds = Math.max(windowEnds, deps.now() + ms); };

  const evaluate = (): boolean => {
    if (restarting || !deps.pending()) return false;
    if (deps.now() > windowEnds) return false;
    const route = deps.route();
    if (route !== null && !REST_ROUTES.includes(route)) return false;
    if (deps.busy()) return false;
    restarting = true;
    // A refused restart leaves this JS running; the next cold start applies the update.
    void deps.reload().catch(() => undefined);
    return true;
  };

  return {
    evaluate,
    earnerSignedIn() {
      open(SIGN_IN_WINDOW_MS);
      return evaluate();
    },
    backgrounded() {
      if (awaySince === null) awaySince = deps.now();
    },
    foregrounded() {
      const away = awaySince === null ? 0 : deps.now() - awaySince;
      awaySince = null;
      if (away < AWAY_MS) return false;
      open(RETURN_WINDOW_MS);
      if (deps.now() - lastCheck >= CHECK_EVERY_MS) {
        lastCheck = deps.now();
        // The download's end is a pending change: services/otaCatchUp.ts evaluates it then.
        void deps.checkAndFetch().catch(() => undefined);
      }
      return evaluate();
    },
  };
}
