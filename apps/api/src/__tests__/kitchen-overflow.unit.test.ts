import { describe, expect, it, vi } from 'vitest';
import {
  busyHoursSchema,
  decideKitchenRoute,
  driverCheckBudgetMs,
  guyanaWeekMinute,
  inBusyHours,
  KITCHEN_ROUTE_REASONS,
  kitchenHoldsOrder,
  kitchenOverflowSettingSchema,
  kitchenStoreView,
  readBusyHours,
  type BusyWindow,
  type DriverCheck,
  type KitchenOverflowModeName,
  type SwiftRiderCheck,
} from '../modules/kitchen/kitchen-overflow';
import { dragontailFreeVehicles } from '../modules/kitchen/dragontail/dragontail-mapper';

// ---------------------------------------------------------------------------
// [DT-OVERFLOW · owner 14 Nov 2026] The pure half of the automatic delivery overflow: busy hours (Guyana time,
// midnight and the week's wrap), the order-by-order decision (which questions are asked, the safe defaults), the
// driver-check answer as Dragontail's spec shapes it, and the store's words.
// ---------------------------------------------------------------------------

/** A Guyana wall-clock instant (UTC-4, no daylight saving): 2026-11-15 is a Sunday. */
const gy = (isoLocal: string) => new Date(`${isoLocal}-04:00`);
const SUN = '2026-11-15';
const MON = '2026-11-16';
const FRI = '2026-11-20';
const SAT = '2026-11-21';
const NEXT_SUN = '2026-11-22';

describe('[DT-OVERFLOW] busy hours, Guyana time', () => {
  it('reads the week minute from the Guyana zone (Sunday 00:00 = 0, Saturday 23:59 = the last minute)', () => {
    expect(guyanaWeekMinute(gy(`${SUN}T00:00:00`))).toBe(0);
    expect(guyanaWeekMinute(gy(`${MON}T18:30:00`))).toBe(1 * 1440 + 18 * 60 + 30);
    expect(guyanaWeekMinute(gy(`${SAT}T23:59:00`))).toBe(7 * 1440 - 1);
    // 02:00 UTC on Monday is still Sunday 22:00 in Guyana.
    expect(guyanaWeekMinute(new Date('2026-11-16T02:00:00Z'))).toBe(22 * 60);
  });

  it('a window is [start, end): its start minute is inside, its end minute is outside', () => {
    const w: BusyWindow[] = [{ day: 1, start: '18:00', end: '21:00' }];
    expect(inBusyHours(w, gy(`${MON}T17:59:00`))).toBe(false);
    expect(inBusyHours(w, gy(`${MON}T18:00:00`))).toBe(true);
    expect(inBusyHours(w, gy(`${MON}T20:59:00`))).toBe(true);
    expect(inBusyHours(w, gy(`${MON}T21:00:00`))).toBe(false);
    // Another day at the same hour is not busy.
    expect(inBusyHours(w, gy(`${SUN}T19:00:00`))).toBe(false);
  });

  it('a window that ends at or before its start runs past midnight into the next day', () => {
    const w: BusyWindow[] = [{ day: 5, start: '22:00', end: '02:00' }]; // Friday 22:00 → Saturday 02:00
    expect(inBusyHours(w, gy(`${FRI}T21:59:00`))).toBe(false);
    expect(inBusyHours(w, gy(`${FRI}T23:30:00`))).toBe(true);
    expect(inBusyHours(w, gy(`${SAT}T00:00:00`))).toBe(true);
    expect(inBusyHours(w, gy(`${SAT}T01:59:00`))).toBe(true);
    expect(inBusyHours(w, gy(`${SAT}T02:00:00`))).toBe(false);
    // Friday 00:00-02:00 (the early hours BEFORE the window's day) is not busy.
    expect(inBusyHours(w, gy(`${FRI}T01:00:00`))).toBe(false);
  });

  it('Saturday night into Sunday morning wraps the week', () => {
    const w: BusyWindow[] = [{ day: 6, start: '23:00', end: '01:00' }];
    expect(inBusyHours(w, gy(`${SAT}T23:30:00`))).toBe(true);
    expect(inBusyHours(w, gy(`${NEXT_SUN}T00:30:00`))).toBe(true);
    expect(inBusyHours(w, gy(`${NEXT_SUN}T01:00:00`))).toBe(false);
    expect(inBusyHours(w, gy(`${SUN}T00:30:00`))).toBe(true); // the previous Saturday night, same rule
  });

  it('"24:00" ends at midnight; 00:00-24:00 is the whole day', () => {
    expect(inBusyHours([{ day: 1, start: '20:00', end: '24:00' }], gy(`${MON}T23:59:00`))).toBe(true);
    expect(inBusyHours([{ day: 1, start: '20:00', end: '24:00' }], gy('2026-11-17T00:00:00'))).toBe(false);
    const allDay: BusyWindow[] = [{ day: 0, start: '00:00', end: '24:00' }];
    expect(inBusyHours(allDay, gy(`${SUN}T00:00:00`))).toBe(true);
    expect(inBusyHours(allDay, gy(`${SUN}T23:59:00`))).toBe(true);
    expect(inBusyHours(allDay, gy(`${MON}T00:00:00`))).toBe(false);
  });

  it('no windows: never busy', () => {
    expect(inBusyHours([], gy(`${MON}T19:00:00`))).toBe(false);
  });

  it('the schema refuses a bad window; the stored list is read tolerantly (bad entries ignored, never thrown)', () => {
    expect(busyHoursSchema.safeParse([{ day: 1, start: '18:00', end: '18:00' }]).success).toBe(false);
    expect(busyHoursSchema.safeParse([{ day: 7, start: '18:00', end: '19:00' }]).success).toBe(false);
    expect(busyHoursSchema.safeParse([{ day: 1, start: '24:00', end: '02:00' }]).success).toBe(false);
    expect(busyHoursSchema.safeParse([{ day: 1, start: '6:00', end: '09:00' }]).success).toBe(false);
    expect(busyHoursSchema.safeParse([{ day: 1, start: '18:00', end: '21:00', extra: 1 }]).success).toBe(false);
    expect(busyHoursSchema.safeParse(Array.from({ length: 29 }, () => ({ day: 1, start: '18:00', end: '21:00' }))).success).toBe(false);
    expect(busyHoursSchema.safeParse([{ day: 5, start: '22:00', end: '02:00' }, { day: 0, start: '00:00', end: '24:00' }]).success).toBe(true);
    expect(readBusyHours([{ day: 1, start: '18:00', end: '21:00' }, { day: 'x' }, null, 'junk'])).toEqual([{ day: 1, start: '18:00', end: '21:00' }]);
    expect(readBusyHours('not a list')).toEqual([]);
    expect(kitchenOverflowSettingSchema.safeParse({ mode: 'SOMETIMES' }).success).toBe(false);
    expect(kitchenOverflowSettingSchema.safeParse({ mode: 'BOTH', busyHours: [] }).success).toBe(true);
  });
});

/** The decision with counted questions. */
function decide(mode: KitchenOverflowModeName, opts: { busy?: boolean; driver?: DriverCheck | Error; riders?: SwiftRiderCheck | Error } = {}) {
  const driverCheck = vi.fn(async (): Promise<DriverCheck> => {
    const d = opts.driver ?? { kind: 'FREE', count: 2, ms: 5 };
    if (d instanceof Error) throw d;
    return d;
  });
  const swiftRiders = vi.fn(async (): Promise<SwiftRiderCheck> => {
    const r = opts.riders ?? { kind: 'NEAR', count: 3 };
    if (r instanceof Error) throw r;
    return r;
  });
  const now = gy(`${MON}T19:00:00`);
  const busyHours: BusyWindow[] = opts.busy ? [{ day: 1, start: '18:00', end: '21:00' }] : [{ day: 2, start: '18:00', end: '21:00' }];
  return { run: () => decideKitchenRoute({ orderId: 'o1', mode, busyHours, now, driverCheck, swiftRiders }), driverCheck, swiftRiders };
}

describe('[DT-OVERFLOW] the decision, order by order', () => {
  it('NONE: the kitchen, and no question is asked', async () => {
    const d = decide('NONE', { busy: true, driver: { kind: 'NONE_FREE', ms: 1 } });
    expect(await d.run()).toMatchObject({ route: 'KITCHEN', reason: 'OVERFLOW_OFF' });
    expect(d.driverCheck).not.toHaveBeenCalled();
    expect(d.swiftRiders).not.toHaveBeenCalled();
  });

  it('BUSY_HOURS inside the hours: Swift riders, and Dragontail is never asked', async () => {
    const d = decide('BUSY_HOURS', { busy: true });
    expect(await d.run()).toMatchObject({ route: 'SWIFT_RIDERS', reason: 'BUSY_HOURS' });
    expect(d.driverCheck).not.toHaveBeenCalled();
    expect(d.swiftRiders).toHaveBeenCalledTimes(1);
  });

  it('BUSY_HOURS outside the hours: the kitchen, no question asked', async () => {
    const d = decide('BUSY_HOURS', { busy: false });
    expect(await d.run()).toMatchObject({ route: 'KITCHEN', reason: 'OUTSIDE_BUSY_HOURS' });
    expect(d.driverCheck).not.toHaveBeenCalled();
    expect(d.swiftRiders).not.toHaveBeenCalled();
  });

  it('AUTO_DRIVER_CHECK: a free driver → the kitchen; none free → Swift riders', async () => {
    const free = decide('AUTO_DRIVER_CHECK', { driver: { kind: 'FREE', count: 1, ms: 40 } });
    expect(await free.run()).toMatchObject({ route: 'KITCHEN', reason: 'DRIVER_FREE' });
    expect(free.swiftRiders).not.toHaveBeenCalled();
    const none = decide('AUTO_DRIVER_CHECK', { driver: { kind: 'NONE_FREE', ms: 40 } });
    expect(await none.run()).toMatchObject({ route: 'SWIFT_RIDERS', reason: 'NO_FREE_DRIVER' });
  });

  it('AUTO_DRIVER_CHECK: a timeout, an error or a throw → the kitchen (the ONE safe default), never Swift riders', async () => {
    for (const driver of [
      { kind: 'FAILED', problem: 'timed out after 2000 ms', ms: 2000 } as DriverCheck,
      { kind: 'FAILED', problem: 'Dragontail PosGetVehicles answered HTTP 404', ms: 30 } as DriverCheck,
      new Error('socket hang up'),
    ]) {
      const d = decide('AUTO_DRIVER_CHECK', { driver });
      const out = await d.run();
      expect(out).toMatchObject({ route: 'KITCHEN', reason: 'DRIVER_CHECK_FAILED' });
      expect(d.swiftRiders).not.toHaveBeenCalled();
    }
  });

  it('BOTH: busy hours answer first (no Dragontail call); outside them, the driver check decides', async () => {
    const inside = decide('BOTH', { busy: true, driver: { kind: 'FREE', count: 4, ms: 1 } });
    expect(await inside.run()).toMatchObject({ route: 'SWIFT_RIDERS', reason: 'BUSY_HOURS' });
    expect(inside.driverCheck).not.toHaveBeenCalled();
    const outsideNone = decide('BOTH', { busy: false, driver: { kind: 'NONE_FREE', ms: 1 } });
    expect(await outsideNone.run()).toMatchObject({ route: 'SWIFT_RIDERS', reason: 'NO_FREE_DRIVER' });
    expect(outsideNone.driverCheck).toHaveBeenCalledTimes(1);
    const outsideFree = decide('BOTH', { busy: false, driver: { kind: 'FREE', count: 1, ms: 1 } });
    expect(await outsideFree.run()).toMatchObject({ route: 'KITCHEN', reason: 'DRIVER_FREE' });
  });

  it('moving it is wanted but no Swift rider near can carry it (or that check fails): the kitchen keeps it', async () => {
    expect(await decide('BUSY_HOURS', { busy: true, riders: { kind: 'NONE_NEAR' } }).run()).toMatchObject({ route: 'KITCHEN', reason: 'NO_SWIFT_RIDER_NEAR' });
    expect(await decide('AUTO_DRIVER_CHECK', { driver: { kind: 'NONE_FREE', ms: 1 }, riders: { kind: 'FAILED', problem: 'db' } }).run()).toMatchObject({ route: 'KITCHEN', reason: 'SWIFT_RIDER_CHECK_FAILED' });
    expect(await decide('AUTO_DRIVER_CHECK', { driver: { kind: 'NONE_FREE', ms: 1 }, riders: new Error('boom') }).run()).toMatchObject({ route: 'KITCHEN', reason: 'SWIFT_RIDER_CHECK_FAILED' });
  });

  it('every reason names exactly one route, and the decision always carries the route its reason names', () => {
    for (const [reason, route] of Object.entries(KITCHEN_ROUTE_REASONS)) expect(['KITCHEN', 'SWIFT_RIDERS'], reason).toContain(route);
    expect(Object.entries(KITCHEN_ROUTE_REASONS).filter(([, r]) => r === 'SWIFT_RIDERS').map(([k]) => k).sort()).toEqual(['BUSY_HOURS', 'NO_FREE_DRIVER']);
  });

  it('the driver check budget: 2 s by default, 300 ms..5 s when set, anything else ignored', () => {
    expect(driverCheckBudgetMs({})).toBe(2_000);
    expect(driverCheckBudgetMs({ DRAGONTAIL_DRIVER_CHECK_MS: '800' })).toBe(800);
    expect(driverCheckBudgetMs({ DRAGONTAIL_DRIVER_CHECK_MS: '60000' })).toBe(2_000);
    expect(driverCheckBudgetMs({ DRAGONTAIL_DRIVER_CHECK_MS: '50' })).toBe(2_000);
    expect(driverCheckBudgetMs({ DRAGONTAIL_DRIVER_CHECK_MS: 'soon' })).toBe(2_000);
  });
});

describe('[DT-OVERFLOW] PosGetVehicles, as the spec shapes it', () => {
  it('counts the listed vehicles (schema `vehicles`, example `vehicle`), never rowCount; unreadable → null', () => {
    expect(dragontailFreeVehicles({ time: 't', rowCount: 8, vehicles: [{ id: '234', number: '234', status: 1 }] })).toBe(1);
    // The spec's own example: `vehicle`, rowCount 8 with three listed (and a typo'd "umber").
    expect(dragontailFreeVehicles({ time: '2019-02-02 00:42:25.233', rowCount: 8, vehicle: [{ id: '234', number: '234', status: 1 }, { id: '345', umber: '345', status: 1 }, { id: '456', number: '456', status: 1 }] })).toBe(3);
    expect(dragontailFreeVehicles({ time: 't', rowCount: 0, vehicles: [] })).toBe(0);
    expect(dragontailFreeVehicles({ time: 't', rowCount: 3 })).toBeNull();
    expect(dragontailFreeVehicles(null)).toBeNull();
    expect(dragontailFreeVehicles('ok')).toBeNull();
    expect(dragontailFreeVehicles({ vehicles: [null, 'x', { id: '1' }] })).toBe(1);
  });
});

describe('[DT-OVERFLOW] the store sees where the order went', () => {
  it('Swift riders: the reason in the store’s words, and it is not in Dragontail', () => {
    expect(kitchenStoreView({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'NO_FREE_DRIVER' }, null)).toMatchObject({
      holdsOrder: false, route: 'SWIFT_RIDERS', title: 'Swift rider: your drivers were all busy',
    });
    expect(kitchenStoreView({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'BUSY_HOURS' }, null)?.title).toBe('Swift rider: it came in during your busy hours');
    expect(kitchenStoreView({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'NO_FREE_DRIVER', fulfillmentMode: 'VENDOR_DELIVERY' }, null)).toMatchObject({ holdsOrder: false, title: 'Your driver delivers this one' });
  });

  it('in Dragontail: holdsOrder (no "Get a Swift rider"); fell back to the tablet: not held', () => {
    for (const state of ['QUEUED', 'SENDING', 'SENT', 'UNKNOWN', 'CANCELLING', 'CANCEL_QUEUED']) {
      expect(kitchenHoldsOrder(state), state).toBe(true);
      expect(kitchenStoreView({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_FREE' }, state)).toMatchObject({ holdsOrder: true, title: 'In Dragontail: your own driver delivers it' });
    }
    expect(kitchenHoldsOrder('FALLBACK')).toBe(false);
    expect(kitchenHoldsOrder(null)).toBe(false);
    expect(kitchenStoreView({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'OVERFLOW_OFF' }, 'FALLBACK')).toMatchObject({ holdsOrder: false, title: 'On this tablet' });
    // An order the integration never touched: nothing to say.
    expect(kitchenStoreView({ kitchenRoute: null }, null)).toBeNull();
  });
});
