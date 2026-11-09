import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AWAY_MS, CHECK_EVERY_MS, LAUNCH_WINDOW_MS, RETURN_WINDOW_MS, SETTLE_MS, SIGN_IN_WINDOW_MS,
  createOtaCatchUp, holdOtaRestart, onOtaHoldsReleased, otaRestartHeld, resetOtaHoldsForTests, type OtaCatchUpDeps,
} from './otaCatchUp';

afterEach(() => resetOtaHoldsForTests());

// [OTA-CATCH-UP · 9 Nov 2026] A store iPad installed from the App Store ran build 12's embedded JS (cut before the
// O-2 hand-overs) and asked for a pickup code the customer was never given. A downloaded update now applies at the
// first moment that cuts nothing, instead of at the next cold start.
function rig(over: Partial<OtaCatchUpDeps> = {}) {
  const s = { t: 1_000_000, pending: false, busy: false, active: true, route: null as string | null };
  const reload = vi.fn(async () => undefined);
  const checkAndFetch = vi.fn(async () => undefined);
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const c = createOtaCatchUp({
    now: () => s.t,
    pending: () => s.pending,
    busy: () => s.busy,
    active: () => s.active,
    route: () => s.route,
    reload,
    checkAndFetch,
    later: (ms, fn) => {
      const timer = { at: s.t + ms, fn, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
    ...over,
  });
  /** Time passes; timers that come due run. */
  const tick = (ms: number) => {
    s.t += ms;
    for (const timer of timers.filter((x) => x.live && x.at <= s.t)) { timer.live = false; timer.fn(); }
  };
  return { s, c, reload, checkAndFetch, tick };
}

describe('a downloaded update applies at a moment that cuts nothing', () => {
  it('fresh install: the update finishes downloading while the app has just opened -> restart into it', () => {
    const { s, c, reload } = rig();
    expect(c.evaluate()).toBe(false); // nothing downloaded yet
    s.t += 5_000;
    s.pending = true;
    expect(c.evaluate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(c.evaluate()).toBe(false); // once
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the store iPad case: a store signs in after the launch window, on its orders board -> restart into the update', () => {
    const { s, c, reload } = rig();
    s.t += LAUNCH_WINDOW_MS + 60_000; // phone number + code typed: the launch window is long gone
    s.pending = true;
    s.route = 'PhoneEntry';
    expect(c.evaluate()).toBe(false);
    s.route = 'OtpVerification';
    expect(c.earnerSignedIn()).toBe(false); // still on the code screen
    s.route = 'Orders';
    s.t += 2_000;
    expect(c.evaluate()).toBe(true); // the board is in front: restart
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never outside a window: a phone in use for a while keeps its JS until the next moment', () => {
    const { s, c, reload } = rig();
    s.route = 'Home';
    s.t += LAUNCH_WINDOW_MS + 1;
    s.pending = true;
    expect(c.evaluate()).toBe(false);
    s.route = 'Selfie';
    expect(c.earnerSignedIn()).toBe(false); // the earner's next gate is not a resting screen
    s.t += SIGN_IN_WINDOW_MS + 1;
    s.route = 'Orders';
    expect(c.evaluate()).toBe(false); // the sign-in window closed before the board came up
    expect(reload).not.toHaveBeenCalled();
  });

  it('never on a screen with something half-done (an order, a checkout, a job, a typed form)', () => {
    const { s, c, reload } = rig();
    s.pending = true;
    for (const route of ['VendorOrderDetail', 'Cart', 'Delivery', 'Taxi', 'ActiveJob', 'MoverRoot', 'PhoneEntry', 'Register']) {
      s.route = route;
      expect(c.evaluate(), route).toBe(false);
    }
    for (const route of ['Home', 'RolePicker', 'Orders']) {
      const r = rig();
      r.s.t += SETTLE_MS;
      r.s.pending = true;
      r.s.route = route;
      expect(r.c.evaluate(), route).toBe(true);
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it('never mid-call or with a write on its way', () => {
    const { s, c, reload } = rig();
    s.t += SETTLE_MS;
    s.pending = true;
    s.route = 'Orders';
    s.busy = true;
    expect(c.evaluate()).toBe(false);
    s.busy = false;
    expect(c.evaluate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('back after a while away: a window opens and the update server is asked (at most every 30 minutes)', () => {
    const { s, c, reload, checkAndFetch } = rig();
    s.route = 'Home';
    s.t += CHECK_EVERY_MS;
    c.backgrounded();
    s.t += AWAY_MS - 1;
    expect(c.foregrounded()).toBe(false); // a glance away: nothing happens
    expect(checkAndFetch).not.toHaveBeenCalled();
    c.backgrounded();
    s.t += AWAY_MS;
    expect(c.foregrounded()).toBe(true); // a window opens; nothing downloaded yet
    expect(checkAndFetch).toHaveBeenCalledTimes(1);
    s.t += SETTLE_MS + 1_000;
    s.pending = true; // the download finished inside the return window
    expect(c.evaluate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a second return within 30 minutes opens a window but does not ask the server again', () => {
    const { s, c, checkAndFetch } = rig();
    s.t += CHECK_EVERY_MS;
    c.backgrounded();
    s.t += AWAY_MS;
    c.foregrounded();
    c.backgrounded();
    s.t += AWAY_MS;
    c.foregrounded();
    expect(checkAndFetch).toHaveBeenCalledTimes(1);
    s.pending = true;
    s.t += RETURN_WINDOW_MS + 1;
    expect(c.evaluate()).toBe(false); // the return window closed
  });

  it('a refused restart or a failed check never throws', async () => {
    const { s, c } = rig({ reload: async () => { throw new Error('no runtime'); }, checkAndFetch: async () => { throw new Error('offline'); } });
    s.t += CHECK_EVERY_MS;
    c.backgrounded();
    s.t += AWAY_MS;
    expect(() => c.foregrounded()).not.toThrow();
    s.t += SETTLE_MS;
    s.pending = true;
    expect(c.evaluate()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
  });
});

// [REVIEW-1 S3-1/L1 on #2431] A screen part that must not be cut (the store's new-order alert, a typed reference)
// holds restarts while it is up.
describe('holds', () => {
  it('held while any hold is taken; the last release tells the listeners, once', () => {
    const released = vi.fn();
    const off = onOtaHoldsReleased(released);
    expect(otaRestartHeld()).toBe(false);
    const a = holdOtaRestart();
    const b = holdOtaRestart();
    expect(otaRestartHeld()).toBe(true);
    a();
    a(); // idempotent
    expect(otaRestartHeld()).toBe(true);
    expect(released).not.toHaveBeenCalled();
    b();
    expect(otaRestartHeld()).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
    off();
    holdOtaRestart()();
    expect(released).toHaveBeenCalledTimes(1);
  });
});

// [REVIEW-2 S2-1 on #2431] Never in the background: a call that woke a closed app (CallKit / ConnectionService) or a
// lock-screen answer keeps the app out of 'active'; Android keeps running JS after the person left.
describe('only while the app is on the screen', () => {
  it('a download that finishes in the background never restarts the app; on the screen again inside a window it does', () => {
    const { s, c, reload, tick } = rig();
    s.route = 'Home';
    tick(SETTLE_MS);
    s.active = false; // the person left at 5 s (or the app was woken by a call)
    s.pending = true;
    expect(c.evaluate()).toBe(false);
    s.active = true;
    expect(c.evaluate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// [REVIEW-2 S3-1 on #2431] After a launch and after a return, what brought the person here (a tapped notification, a
// scanned link, the store's new-order alert) lands first.
describe('the settle after a launch and a return', () => {
  it('launch: an update already downloaded waits out the settle, then restarts (on its own timer)', () => {
    const { s, c, reload, tick } = rig();
    s.route = 'Home';
    s.pending = true;
    expect(c.evaluate()).toBe(false);
    tick(SETTLE_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    tick(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('return: never on the same tick as "active"; after the settle it restarts', () => {
    const { s, c, reload, tick } = rig();
    s.route = 'Orders';
    tick(LAUNCH_WINDOW_MS + 1);
    s.pending = true; // downloaded earlier, after its own window
    c.backgrounded();
    tick(AWAY_MS);
    c.foregrounded();
    expect(reload).not.toHaveBeenCalled();
    expect(c.evaluate()).toBe(false); // a navigation or download event inside the settle does not restart either
    tick(SETTLE_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('return, then the tap lands inside the settle (busy): no restart', () => {
    const { s, c, reload, tick } = rig();
    s.route = 'Home';
    tick(LAUNCH_WINDOW_MS + 1);
    s.pending = true;
    c.backgrounded();
    tick(AWAY_MS);
    c.foregrounded();
    tick(1_000);
    s.busy = true; // the tapped notification is landing
    tick(SETTLE_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('left again before the settle ended: that return never restarts', () => {
    const { s, c, reload, tick } = rig();
    s.route = 'Home';
    tick(LAUNCH_WINDOW_MS + 1);
    s.pending = true;
    c.backgrounded();
    tick(AWAY_MS);
    c.foregrounded();
    tick(1_000);
    c.backgrounded();
    s.active = false;
    tick(SETTLE_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('left and back within a glance inside the settle: the first return\'s timer never restarts the app', () => {
    const { s, c, reload, tick } = rig();
    s.route = 'Home';
    tick(LAUNCH_WINDOW_MS + 1);
    s.pending = true;
    c.backgrounded();
    tick(AWAY_MS);
    c.foregrounded();
    tick(1_000);
    c.backgrounded();
    tick(1_000);
    expect(c.foregrounded()).toBe(false); // a glance away: no new window, no new settle
    tick(SETTLE_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('disposed: the settle timer does nothing', () => {
    const { s, c, reload, tick } = rig();
    s.route = 'Home';
    s.pending = true;
    c.dispose();
    tick(SETTLE_MS);
    expect(reload).not.toHaveBeenCalled();
  });
});
