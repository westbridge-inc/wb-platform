import { describe, expect, it } from 'vitest';
import { busyWindowProblem, busyWindowWords, kitchenHoldsOrder, OVERFLOW_MODE_OPTIONS, usesBusyHours } from './deliveryOverflow';
import { deliveryOwnerView } from './screens/delivery-owner';

// [DT-OVERFLOW · owner 14 Nov 2026] The store's side of automatic delivery overflow: "Get a Swift rider" is never
// offered on an order Dragontail has (Dragontail is not told: two drivers), and the busy-hours words and checks match
// the server's rules.

const own = { fulfillment: 'DELIVERY', fulfillmentMode: 'VENDOR_DELIVERY', status: 'PREPARING', riderId: null, selfDeliveryEnabled: true };

describe('[DT-OVERFLOW] the delivery owner card', () => {
  it('an own-delivery order with no kitchen system keeps "Get a Swift rider" (unchanged)', () => {
    expect(deliveryOwnerView(own).canChoosePlatform).toBe(true);
    expect(deliveryOwnerView({ ...own, kitchen: null }).canChoosePlatform).toBe(true);
  });

  it('Dragontail has it: no "Get a Swift rider", and the card says so in the store’s words', () => {
    const view = deliveryOwnerView({ ...own, kitchen: { holdsOrder: true, title: 'In Dragontail: your own driver delivers it', detail: 'Sent to Dragontail.' } });
    expect(view.canChoosePlatform).toBe(false);
    expect(view.title).toBe('In Dragontail: your own driver delivers it');
    expect(view.description).toContain('Dispatch it from Dragontail');
    expect(view.kitchenNote).toBeNull();
  });

  it('it fell back to the tablet, or Swift moved it to its riders: the choice stays, and the reason is shown', () => {
    const back = deliveryOwnerView({ ...own, kitchen: { holdsOrder: false, title: 'On this tablet', detail: 'Dragontail could not take this order.' } });
    expect(back.canChoosePlatform).toBe(true);
    expect(back.kitchenNote?.title).toBe('On this tablet');
    const moved = deliveryOwnerView({ ...own, fulfillmentMode: 'PLATFORM_RIDER', kitchen: { holdsOrder: false, route: 'SWIFT_RIDERS', title: 'Swift rider: your drivers were all busy' } });
    expect(moved.kitchenNote?.title).toBe('Swift rider: your drivers were all busy');
  });

  it('an older server (no kitchen field) changes nothing', () => {
    expect(kitchenHoldsOrder(undefined)).toBe(false);
    expect(deliveryOwnerView(own).kitchenNote).toBeNull();
  });
});

describe('[DT-OVERFLOW] busy hours as the store types them', () => {
  it('checks a window as the server does', () => {
    expect(busyWindowProblem({ day: 5, start: '22:00', end: '02:00' })).toBeNull();
    expect(busyWindowProblem({ day: 0, start: '00:00', end: '24:00' })).toBeNull();
    expect(busyWindowProblem({ day: 1, start: '18:00', end: '18:00' })).toMatch(/differ/);
    expect(busyWindowProblem({ day: 1, start: '6pm', end: '21:00' })).toMatch(/Start/);
    expect(busyWindowProblem({ day: 1, start: '18:00', end: '25:00' })).toMatch(/End/);
    expect(busyWindowProblem({ day: 7, start: '18:00', end: '21:00' })).toMatch(/day/);
  });

  it('says past-midnight windows plainly', () => {
    expect(busyWindowWords({ day: 5, start: '22:00', end: '02:00' })).toBe('Friday 22:00 – 02:00 (next day)');
    expect(busyWindowWords({ day: 1, start: '18:00', end: '21:00' })).toBe('Monday 18:00 – 21:00');
    expect(busyWindowWords({ day: 1, start: '20:00', end: '24:00' })).toBe('Monday 20:00 – 24:00');
  });

  it('offers the four modes, off first; busy hours only for the two that use them', () => {
    expect(OVERFLOW_MODE_OPTIONS.map((o) => o.mode)).toEqual(['NONE', 'AUTO_DRIVER_CHECK', 'BUSY_HOURS', 'BOTH']);
    expect(OVERFLOW_MODE_OPTIONS.filter((o) => usesBusyHours(o.mode)).map((o) => o.mode)).toEqual(['BUSY_HOURS', 'BOTH']);
  });
});
