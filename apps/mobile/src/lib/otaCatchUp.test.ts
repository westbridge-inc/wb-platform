import { describe, expect, it, vi } from 'vitest';
import {
  AWAY_MS, CHECK_EVERY_MS, LAUNCH_WINDOW_MS, RETURN_WINDOW_MS, SIGN_IN_WINDOW_MS,
  createOtaCatchUp, type OtaCatchUpDeps,
} from './otaCatchUp';

// [OTA-CATCH-UP · 9 Nov 2026] A store iPad installed from the App Store ran build 12's embedded JS (cut before the
// O-2 hand-overs) and asked for a pickup code the customer was never given. A downloaded update now applies at the
// first moment that cuts nothing, instead of at the next cold start.
function rig(over: Partial<OtaCatchUpDeps> = {}) {
  const s = { t: 1_000_000, pending: false, busy: false, route: null as string | null };
  const reload = vi.fn(async () => undefined);
  const checkAndFetch = vi.fn(async () => undefined);
  const c = createOtaCatchUp({
    now: () => s.t,
    pending: () => s.pending,
    busy: () => s.busy,
    route: () => s.route,
    reload,
    checkAndFetch,
    ...over,
  });
  return { s, c, reload, checkAndFetch };
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
      r.s.pending = true;
      r.s.route = route;
      expect(r.c.evaluate(), route).toBe(true);
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it('never mid-call or with a write on its way', () => {
    const { s, c, reload } = rig();
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
    expect(c.foregrounded()).toBe(false); // nothing downloaded yet
    expect(checkAndFetch).toHaveBeenCalledTimes(1);
    s.t += 3_000;
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
    s.pending = true;
    expect(c.evaluate()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
  });
});
