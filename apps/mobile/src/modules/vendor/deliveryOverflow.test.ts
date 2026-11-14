import { describe, expect, it } from 'vitest';
import { busyWindowProblem, busyWindowWords, kitchenHoldsOrder, kitchenLinkNote, LINK_OFFLINE_DETAIL, OVERFLOW_MODE_OPTIONS, overflowModeLocked, usesBusyHours, withKitchenHold, type OrderKitchenView } from './deliveryOverflow';
import { deliveryOwnerView, type DeliveryOwnerInput } from './screens/delivery-owner';

/** The phone's order screen: the delivery card, then the kitchen system's facts on it. */
const card = (input: DeliveryOwnerInput & { kitchen?: OrderKitchenView | null }) => withKitchenHold(deliveryOwnerView(input), input.kitchen);

// [DT-OVERFLOW · owner 14 Nov 2026] The store's side of automatic delivery overflow: "Get a Swift rider" is never
// offered on an order Dragontail has (Dragontail is not told: two drivers), and the busy-hours words and checks match
// the server's rules.

const own = { fulfillment: 'DELIVERY', fulfillmentMode: 'VENDOR_DELIVERY', status: 'PREPARING', riderId: null, selfDeliveryEnabled: true };

describe('[DT-OVERFLOW] the delivery owner card', () => {
  it('an own-delivery order with no kitchen system keeps "Get a Swift rider" (unchanged)', () => {
    expect(card(own).canChoosePlatform).toBe(true);
    expect(card({ ...own, kitchen: null }).canChoosePlatform).toBe(true);
  });

  it('Dragontail has it: no "Get a Swift rider", and the card says so in the store’s words', () => {
    const view = card({ ...own, kitchen: { holdsOrder: true, title: 'In Dragontail: your own driver delivers it', detail: 'Sent to Dragontail.' } });
    expect(view.canChoosePlatform).toBe(false);
    expect(view.title).toBe('In Dragontail: your own driver delivers it');
    expect(view.description).toContain('Dispatch it from Dragontail');
    expect(view.kitchenNote).toBeNull();
  });

  it('it fell back to the tablet, or Swift moved it to its riders: the choice stays, and the reason is shown', () => {
    const back = card({ ...own, kitchen: { holdsOrder: false, title: 'On this tablet', detail: 'Dragontail could not take this order.' } });
    expect(back.canChoosePlatform).toBe(true);
    expect(back.kitchenNote?.title).toBe('On this tablet');
    const moved = card({ ...own, fulfillmentMode: 'PLATFORM_RIDER', kitchen: { holdsOrder: false, route: 'SWIFT_RIDERS', title: 'Swift rider: your drivers were all busy' } });
    expect(moved.kitchenNote?.title).toBe('Swift rider: your drivers were all busy');
  });

  it('an older server (no kitchen field) changes nothing', () => {
    expect(kitchenHoldsOrder(undefined)).toBe(false);
    expect(card(own).kitchenNote).toBeNull();
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

describe('[round 2] the driver check waits for Dragontail', () => {
  it('its two choices are locked unless the server says the check is on; off and busy hours never are', () => {
    for (const setting of [undefined, null, {}, { driverCheckAvailable: false }]) {
      expect(overflowModeLocked('AUTO_DRIVER_CHECK', setting)).toBe(true);
      expect(overflowModeLocked('BOTH', setting)).toBe(true);
      expect(overflowModeLocked('NONE', setting)).toBe(false);
      expect(overflowModeLocked('BUSY_HOURS', setting)).toBe(false);
    }
    expect(overflowModeLocked('AUTO_DRIVER_CHECK', { driverCheckAvailable: true })).toBe(false);
    expect(overflowModeLocked('BOTH', { driverCheckAvailable: true })).toBe(false);
  });
});

describe('[follow-up · review B S4-9] the tablet\u2019s order screen note for an offline kitchen link (every store role)', () => {
  it('only when the server says the link is offline; the words promise no fixed check interval', () => {
    expect(kitchenLinkNote({ deliveryOpen: true, kitchenLink: { offline: true, since: null } })).toMatchObject({ title: 'Kitchen link offline, orders on tablet' });
    for (const s of [null, {}, { kitchenLink: null }, { kitchenLink: { offline: false } }]) expect(kitchenLinkNote(s)).toBeNull();
    expect(LINK_OFFLINE_DETAIL).not.toMatch(/every minute/);
  });
});

