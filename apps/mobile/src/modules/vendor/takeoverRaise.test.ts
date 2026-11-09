import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HANDLED_TAKEOVERS_REMEMBERED,
  markTakeoverHandled,
  isStoreAlertPush,
  resetHandledTakeovers,
  storeAlertFromPush,
  takeoverHandled,
  waitingForStore,
  withRaised,
  pruneHandledTakeovers,
} from './takeoverRaise';
import { bindHandledTakeoverStorage, forgetHandledTakeovers, HANDLED_TAKEOVERS_STORAGE_KEY } from '../../lib/handledTakeovers';

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

const LATER = NOW + 10 * 60_000;
function deviceStorage() {
  const kv = new Map<string, string>();
  return { kv, getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => { kv.set(k, v); }, removeItem: (k: string) => { kv.delete(k); } };
}
afterEach(() => bindHandledTakeoverStorage(null));

describe('handled orders', () => {
  it('per store, and bounded (the oldest leaves first)', () => {
    markTakeoverHandled('u1', 'store-a', 'o1', LATER);
    expect(takeoverHandled('u1', 'store-a', 'o1', NOW)).toBe(true);
    expect(takeoverHandled('u1', 'store-b', 'o1', NOW)).toBe(false);
    for (let i = 0; i < HANDLED_TAKEOVERS_REMEMBERED; i += 1) markTakeoverHandled('u1', 'store-a', `n${i}`, LATER);
    expect(takeoverHandled('u1', 'store-a', 'o1', NOW)).toBe(false);
    expect(takeoverHandled('u1', 'store-a', `n${HANDLED_TAKEOVERS_REMEMBERED - 1}`, NOW)).toBe(true);
  });

  it('[S4-2] survives a restart on the device, for the same account only', () => {
    const device = deviceStorage();
    bindHandledTakeoverStorage(device);
    markTakeoverHandled('u1', 'store-a', 'o1', LATER);
    resetHandledTakeovers(); // a cold start: this run's memory is gone, the device keeps its copy
    expect(takeoverHandled('u1', 'store-a', 'o1', NOW)).toBe(true); // RED before: memory only
    expect(takeoverHandled('u2', 'store-a', 'o1', NOW)).toBe(false); // another account never inherits it
    markTakeoverHandled('u2', 'store-a', 'o9', LATER); // ...and its own write replaces it
    resetHandledTakeovers();
    expect(takeoverHandled('u1', 'store-a', 'o1', NOW)).toBe(false);
    expect(takeoverHandled('u2', 'store-a', 'o9', NOW)).toBe(true);
    expect(JSON.parse(device.kv.get(HANDLED_TAKEOVERS_STORAGE_KEY)!)).toEqual({ u: 'u2', s: { 'store-a': { o9: LATER } } });
  });

  it('[S4-2] signed out (no account): this run only, never written to the device', () => {
    const device = deviceStorage();
    bindHandledTakeoverStorage(device);
    markTakeoverHandled(null, 'store-a', 'o1', LATER);
    expect(takeoverHandled(null, 'store-a', 'o1', NOW)).toBe(true);
    expect(device.kv.size).toBe(0);
  });

  it('[S4-2] sign-out wipes it, on the device too', () => {
    const device = deviceStorage();
    bindHandledTakeoverStorage(device);
    markTakeoverHandled('u1', 'store-a', 'o1', LATER);
    forgetHandledTakeovers();
    expect(device.kv.size).toBe(0);
    expect(takeoverHandled('u1', 'store-a', 'o1', NOW)).toBe(false);
  });

  it('[S4-2] forgotten once its accept window ends, or once the board shows it left PENDING; an earlier window shortens it', () => {
    const device = deviceStorage();
    bindHandledTakeoverStorage(device);
    markTakeoverHandled('u1', 'store-a', 'gone', LATER);
    markTakeoverHandled('u1', 'store-a', 'accepted', LATER);
    markTakeoverHandled('u1', 'store-a', 'waiting', LATER);
    markTakeoverHandled('u1', 'store-a', 'sooner', LATER);
    expect(takeoverHandled('u1', 'store-a', 'gone', LATER)).toBe(false); // the window is over
    const sooner = NOW + 60_000;
    pruneHandledTakeovers('u1', 'store-a', [
      row('accepted', { status: 'ACCEPTED' }),
      row('waiting'),
      row('sooner', { respondBy: new Date(sooner).toISOString() }),
    ], NOW);
    expect(takeoverHandled('u1', 'store-a', 'accepted', NOW)).toBe(false);
    expect(takeoverHandled('u1', 'store-a', 'waiting', NOW)).toBe(true);
    expect(takeoverHandled('u1', 'store-a', 'sooner', NOW)).toBe(true);
    expect(takeoverHandled('u1', 'store-a', 'sooner', sooner)).toBe(false);
    pruneHandledTakeovers('u1', 'store-a', [], sooner);
    expect(Object.keys(JSON.parse(device.kv.get(HANDLED_TAKEOVERS_STORAGE_KEY)!).s['store-a']).sort()).toEqual(['gone', 'waiting']); // 'sooner' left at its window's end
    pruneHandledTakeovers('u1', 'store-a', [], LATER);
    expect(device.kv.has(HANDLED_TAKEOVERS_STORAGE_KEY)).toBe(false); // nothing left: nothing kept
  });

  it('[review S3-1] a new decision for the store is never suppressed: waiting on the customer, or a window moved later', () => {
    const device = deviceStorage();
    bindHandledTakeoverStorage(device);
    markTakeoverHandled('u1', 'store-a', 'asked', LATER); // "Out of stock" asked: the takeover settled
    markTakeoverHandled('u1', 'store-a', 'answered', LATER);
    pruneHandledTakeovers('u1', 'store-a', [
      row('asked', { respondBy: new Date(LATER).toISOString(), items: [{ id: 'l', subStatus: 'PENDING', substituteName: null }] }),
      // The customer answered: the store's clock restarted, its window now ends later.
      row('answered', { respondBy: new Date(LATER + 5 * 60_000).toISOString() }),
    ], NOW);
    expect(takeoverHandled('u1', 'store-a', 'asked', NOW)).toBe(false);
    expect(takeoverHandled('u1', 'store-a', 'answered', NOW)).toBe(false); // RED before: extended to the new window
    expect(waitingForStore([row('answered', { respondBy: new Date(LATER + 5 * 60_000).toISOString() })], 'store-a', NOW).map((e) => e.orderId)).toEqual(['answered']);
  });

  it('[review S4] a sign-out that cannot remove the device copy still never reads it back', () => {
    const kv = new Map<string, string>();
    bindHandledTakeoverStorage({ getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => { kv.set(k, v); }, removeItem: () => { throw new Error('locked'); } });
    markTakeoverHandled('u1', 'store-a', 'o1', LATER);
    forgetHandledTakeovers();
    expect(takeoverHandled('u1', 'store-a', 'o1', NOW)).toBe(false); // the same account signing back in
    expect(JSON.parse(kv.get(HANDLED_TAKEOVERS_STORAGE_KEY)!)).toEqual({ u: null, s: {} });
  });

  it('[review S4] ...even when the device refuses every write at sign-out (the old copy stays unread)', () => {
    const kv = new Map<string, string>();
    let locked = false;
    bindHandledTakeoverStorage({
      getItem: (k) => kv.get(k) ?? null,
      setItem: (k, v) => { if (locked) throw new Error('locked'); kv.set(k, v); },
      removeItem: () => { throw new Error('locked'); },
    });
    markTakeoverHandled('u1', 'store-a', 'o1', LATER);
    locked = true;
    forgetHandledTakeovers();
    expect(kv.has(HANDLED_TAKEOVERS_STORAGE_KEY)).toBe(true); // still on the device...
    expect(takeoverHandled('u1', 'store-a', 'o1', NOW)).toBe(false); // ...never read back in this run
  });

  it('[S4-2] an unreadable device copy starts empty', () => {
    const device = deviceStorage();
    device.kv.set(HANDLED_TAKEOVERS_STORAGE_KEY, '{not json');
    bindHandledTakeoverStorage(device);
    expect(takeoverHandled('u1', 'store-a', 'o1', NOW)).toBe(false);
    bindHandledTakeoverStorage({ getItem: () => { throw new Error('locked'); }, setItem: () => { throw new Error('locked'); }, removeItem: () => {} });
    markTakeoverHandled('u1', 'store-a', 'o1', LATER);
    expect(takeoverHandled('u1', 'store-a', 'o1', NOW)).toBe(true); // this run still remembers
  });
});
