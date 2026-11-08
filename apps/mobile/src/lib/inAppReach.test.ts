import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  MIC_ASK_QUIET_MS,
  REACH_KEYS,
  isReachKey,
  mayAskForMic,
  parseMicMemory,
  reachSignal,
  reachSignalFromCache,
  rememberMicRefusal,
} from './inAppReach';

// [CALLS-REACH · live test 8 Nov 2026] "Is this person on a live order?" from what the app already holds,
// and when Android's microphone may be asked for.

const DAY = 24 * 60 * 60_000;

describe('[CALLS-REACH] the live-order signal', () => {
  it('a customer with a store pickup order (no rider) is live, as a customer', () => {
    const s = reachSignal({ customerLive: { items: [{ id: 'o1', status: 'PREPARING', fulfillment: 'PICKUP', riderId: null }] } });
    expect(s).toEqual({ state: 'live', orderIds: ['o1'], audience: 'customer' });
  });

  it('a mover\'s active job and a store board with an open order are live, as a partner', () => {
    expect(reachSignal({ moverActive: [null, { id: 'j1', status: 'PICKED_UP' }] })).toEqual({ state: 'live', orderIds: ['j1'], audience: 'partner' });
    expect(reachSignal({ storeOrders: [{ id: 'd1', status: 'DELIVERED' }, { id: 'p1', status: 'PENDING' }] })).toEqual({ state: 'live', orderIds: ['p1'], audience: 'partner' });
  });

  it('a passenger\'s ride counts; a finished one does not', () => {
    expect(reachSignal({ activeRide: { id: 't1', status: 'DRIVER_EN_ROUTE' } }).state).toBe('live');
    expect(reachSignal({ activeRide: { id: 't1', status: 'COMPLETED' } }).state).toBe('none');
    expect(reachSignal({ activeRide: null }).state).toBe('none');
  });

  it('every finished status is not live (the server\'s TERMINAL_ORDER_STATUSES)', () => {
    for (const status of ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'RETURNED', 'delivered']) {
      expect(reachSignal({ customerLive: { items: [{ id: 'o', status }] } }).state, status).toBe('none');
    }
    for (const status of ['PENDING', 'ACCEPTED', 'READY_FOR_PICKUP', 'RETURNING', 'RIDE_IN_PROGRESS']) {
      expect(reachSignal({ customerLive: { items: [{ id: 'o', status }] } }).state, status).toBe('live');
    }
  });

  it('nothing read yet is "unknown" (never a reason to unregister); an empty read is "none"', () => {
    expect(reachSignal({})).toEqual({ state: 'unknown', orderIds: [], audience: null });
    expect(reachSignal({ moverActive: [undefined] }).state).toBe('unknown');
    expect(reachSignal({ customerLive: { items: [] } }).state).toBe('none');
    expect(reachSignal({ storeOrders: [] }).state).toBe('none');
  });

  it('a person on both sides reads the customer words', () => {
    expect(reachSignal({ customerLive: { items: [{ id: 'o1', status: 'PENDING' }] }, storeOrders: [{ id: 'p1', status: 'PENDING' }] }))
      .toEqual({ state: 'live', orderIds: ['o1', 'p1'], audience: 'customer' });
  });
});

describe('[CALLS-REACH] read from the React Query cache, never fetched', () => {
  it('the keys are the hooks\' own keys (census over the hooks\' source)', () => {
    const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
    expect(src('../hooks/customer.ts')).toContain("queryKey: [...customerKeys.orders, 'live'],");
    expect(src('../hooks/customer.ts')).toContain("orders: ['customer', 'orders'] as const,");
    expect(src('../hooks/rides.ts')).toContain("queryKey: ['rides', 'active'],");
    expect(src('../hooks/mover.ts')).toContain("queryKey: ['mover', 'active', kind],");
    expect(src('../hooks/vendorops.ts')).toContain("queryKey: ['vendor', 'orders'],");
    expect(REACH_KEYS).toEqual({
      customerLive: ['customer', 'orders', 'live'], activeRide: ['rides', 'active'], moverActive: ['mover', 'active'], storeOrders: ['vendor', 'orders'],
    });
  });

  it('a real QueryClient: what the app holds decides; a stacked rider\'s legs are not a job', () => {
    const client = new QueryClient();
    expect(reachSignalFromCache(client).state).toBe('unknown');
    client.setQueryData(['customer', 'orders', 'live'], { items: [], total: 0 });
    expect(reachSignalFromCache(client).state).toBe('none');
    client.setQueryData(['mover', 'active', 'RIDER', 'legs'], { legs: [{ id: 'leg' }], run: null });
    expect(reachSignalFromCache(client).state).toBe('none');
    client.setQueryData(['mover', 'active', 'RIDER'], { id: 'j1', status: 'PICKED_UP' });
    expect(reachSignalFromCache(client)).toEqual({ state: 'live', orderIds: ['j1'], audience: 'partner' });
    client.setQueryData(['mover', 'active', 'RIDER'], null);
    client.setQueryData(['customer', 'orders', 'live'], { items: [{ id: 'o9', status: 'READY_FOR_PICKUP' }], total: 1 });
    expect(reachSignalFromCache(client)).toEqual({ state: 'live', orderIds: ['o9'], audience: 'customer' });
  });

  it('only those queries move the signal', () => {
    expect(isReachKey(['customer', 'orders', 'live'])).toBe(true);
    expect(isReachKey(['rides', 'active'])).toBe(true);
    expect(isReachKey(['mover', 'active', 'DRIVER'])).toBe(true);
    expect(isReachKey(['vendor', 'orders'])).toBe(true);
    for (const key of [['customer', 'orders'], ['customer', 'orders', 'infinite', 'history'], ['mover', 'active', 'RIDER', 'legs'], ['vendor', 'orders', 'x'], ['customer', 'home']]) {
      expect(isReachKey(key), key.join('/')).toBe(false);
    }
  });
});

describe('[CALLS-REACH] Android\'s microphone: once, never a nag', () => {
  it('never asked: ask', () => {
    expect(mayAskForMic(null, ['o1'], 0)).toBe(true);
  });

  it('a refusal is remembered for that order, and for a week for any other', () => {
    const m = rememberMicRefusal(null, ['o1'], 1_000);
    expect(mayAskForMic(m, ['o1'], 1_000 + 30 * DAY)).toBe(false); // that order: never again
    expect(mayAskForMic(m, ['o2'], 1_000 + DAY)).toBe(false); // another order the next day: still quiet
    expect(mayAskForMic(m, ['o2'], 1_000 + MIC_ASK_QUIET_MS)).toBe(true); // a week on, a new order: once more
    expect(MIC_ASK_QUIET_MS).toBe(7 * DAY);
  });

  it('Android\'s "don\'t ask again" is for good; the memory keeps the newest orders only', () => {
    const never = rememberMicRefusal(rememberMicRefusal(null, ['o1'], 0), ['o2'], 5, true);
    expect(mayAskForMic(never, ['o3'], 365 * DAY)).toBe(false);
    expect(rememberMicRefusal(never, ['o4'], 10).never).toBe(true);
    const many = Array.from({ length: 30 }, (_, i) => `o${i}`);
    expect(rememberMicRefusal(null, many, 0).orders).toHaveLength(20);
  });

  it('the stored value is read defensively', () => {
    const m = rememberMicRefusal(null, ['o1'], 42);
    expect(parseMicMemory(JSON.stringify(m))).toEqual(m);
    for (const raw of [null, '', 'not json', '{}', '{"at":"x","orders":[]}', '{"at":1}', 'null']) expect(parseMicMemory(raw), String(raw)).toBeNull();
    expect(parseMicMemory('{"at":1,"orders":["a",2,null]}')).toEqual({ at: 1, orders: ['a'] });
  });
});
