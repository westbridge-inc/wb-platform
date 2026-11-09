import { beforeEach, describe, expect, it } from 'vitest';
import {
  HANDLED_TAKEOVERS_REMEMBERED,
  markTakeoverHandled,
  isStoreAlertPush,
  resetHandledTakeovers,
  storeAlertFromPush,
  takeoverHandled,
  waitingForStore,
  withRaised,
} from './takeoverRaise';

// [STORE-ALERT-RECONNECT] The rules behind raising the new-order screen from the board's read and
// from a foreground push (hooks/vendorops useVendorOrdersLive drives them on a real renderer).

const NOW = Date.parse('2026-11-08T12:00:00Z');
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, orderNumber: id.toUpperCase(), status: 'PENDING', vendorId: 'store-a', items: [], ...extra });

beforeEach(() => resetHandledTakeovers());

describe('waitingForStore', () => {
  it('only orders still waiting for this store\'s answer', () => {
    expect(waitingForStore([
      row('ok'),
      row('no-store-field', { vendorId: undefined }),
      row('accepted', { status: 'ACCEPTED' }),
      row('asked', { items: [{ id: 'l', subStatus: 'PENDING', substituteName: null }] }),
      row('late', { respondBy: new Date(NOW - 1).toISOString() }),
      row('open', { respondBy: new Date(NOW + 60_000).toISOString() }),
      row('branch', { vendorId: 'store-b' }),
      row('busy'),
      { status: 'PENDING' },
      null,
    ], 'store-a', NOW, new Set(['busy'])).map((e) => e.orderId)).toEqual(['ok', 'no-store-field', 'open']);
  });

  it('a board that is not a list raises nothing', () => {
    expect(waitingForStore(undefined, 'store-a', NOW)).toEqual([]);
    expect(waitingForStore({ data: [row('x')] }, 'store-a', NOW)).toEqual([]);
  });
});

describe('storeAlertFromPush', () => {
  it('raises at once only the new-order push that names THIS store', () => {
    expect(storeAlertFromPush({ kind: 'vendor_order_alert', orderId: 'o1', orderNumber: 'N1', vendorId: 'store-a' }, 'store-a')).toEqual({ orderId: 'o1', orderNumber: 'N1' });
  });
  it('[review S3] a push naming no store could be another branch\'s order: not raised (the board re-read decides)', () => {
    expect(storeAlertFromPush({ kind: 'vendor_order_alert', orderId: 'o1' }, 'store-a')).toBeNull();
    expect(isStoreAlertPush({ kind: 'vendor_order_alert', orderId: 'o1' })).toBe(true);
    expect(isStoreAlertPush({ kind: 'dispatch_offer', orderId: 'o1' })).toBe(false);
  });
  it('never another kind, another branch, or a push with no order', () => {
    expect(storeAlertFromPush({ kind: 'dispatch_offer', orderId: 'o1' }, 'store-a')).toBeNull();
    expect(storeAlertFromPush({ kind: 'vendor_order_alert', orderId: 'o1', vendorId: 'store-b' }, 'store-a')).toBeNull();
    expect(storeAlertFromPush({ kind: 'vendor_order_alert', orderId: '' }, 'store-a')).toBeNull();
    expect(storeAlertFromPush({ kind: 'vendor_order_alert', orderId: 7 }, 'store-a')).toBeNull();
  });
});

describe('withRaised', () => {
  it('adds new orders in order, once each; the SAME array when nothing is new', () => {
    const q = [{ orderId: 'a' }];
    expect(withRaised(q, [{ orderId: 'b' }, { orderId: 'a' }, { orderId: 'b' }])).toEqual([{ orderId: 'a' }, { orderId: 'b' }]);
    expect(withRaised(q, [{ orderId: 'a' }])).toBe(q);
    expect(withRaised(q, [{ orderId: 'c' }], (id) => id === 'c')).toBe(q);
  });
});

describe('handled orders', () => {
  it('per store, and bounded (the oldest leaves first)', () => {
    markTakeoverHandled('store-a', 'o1');
    expect(takeoverHandled('store-a', 'o1')).toBe(true);
    expect(takeoverHandled('store-b', 'o1')).toBe(false);
    for (let i = 0; i < HANDLED_TAKEOVERS_REMEMBERED; i += 1) markTakeoverHandled('store-a', `n${i}`);
    expect(takeoverHandled('store-a', 'o1')).toBe(false);
    expect(takeoverHandled('store-a', `n${HANDLED_TAKEOVERS_REMEMBERED - 1}`)).toBe(true);
  });
});
