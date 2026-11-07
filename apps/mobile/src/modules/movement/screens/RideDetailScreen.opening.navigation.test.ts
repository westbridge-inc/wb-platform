/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// [APP-SPEED A] "View ride" opened a blank spinner although Orders held the ride. The ride's row from the
// Orders lists is drawn at once as "checking": no fare, no rating, no help door until the server answers.
// The REAL screen over a REAL query (the setup of RideDetailScreen.navigation.test); only native drawing,
// the kit and the network are stand-ins.

const fx = vi.hoisted(() => ({
  read: { promise: Promise.resolve({}) as Promise<unknown>, resolve: (_v: unknown) => {}, reject: (_e: unknown) => {} },
  ride: {} as Record<string, unknown>,
  rate: vi.fn((_body: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, p.children);
  return { View, ScrollView: View };
});
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    Screen: Box, Header: (p: any) => h('h1', null, p.title), IconChip: () => null, LoadingBlock: () => h('span', null, 'loading'), ErrorState: () => h('span', null, 'failed'),
    T: (p: any) => h('span', null, p.children),
    Stars: (p: any) => h('button', { type: 'button', onClick: () => p.onRate?.(5) }, 'stars'),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress, disabled: !!p.disabled }, p.label),
  };
});
vi.mock('../../../hooks/customer', () => ({ useRateOrder: () => ({ mutate: fx.rate, isPending: false }) }));
vi.mock('../../../lib/money', () => ({ money: (n: number) => `GY$${Number(n).toLocaleString('en-US')}` }));
vi.mock('../../../services/api', () => ({ rideApi: { get: () => fx.read.promise } }));

import { RideDetailScreen } from './RideDetailScreen';

const ROW = { id: 'r1', orderNumber: 'SW-1', orderType: 'TAXI', status: 'DELIVERED', pickupAddress: 'Stabroek', deliveryAddress: 'Kitty', totalAmount: 1100 };
const finished = {
  ...ROW, taxiFareTotal: 800, hasBeenRated: false,
  driver: { vehicleColor: 'White', vehicleMake: 'Toyota', vehicleModel: 'Axio', licensePlate: 'PAB 1234', user: { firstName: 'Dan' } },
  fareBreakdown: { routeFare: 800, waitingMinutes: 12, waitingCharge: 300, total: 1100, currencyCode: 'GYD' },
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const navigate = vi.fn();
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
async function open() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(RideDetailScreen, { navigation: { navigate }, route: { params: { rideId: 'r1' } } }))));
}

beforeEach(() => {
  navigate.mockClear(); fx.rate.mockClear();
  let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  fx.read = { promise, resolve, reject };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); });

describe('[APP-SPEED A] a finished ride opens on the row Orders already has', () => {
  it('route and order number at once, "checking", no money, no rating, no help; the server’s ride replaces it', async () => {
    client.setQueryData(['customer', 'orders', 'infinite', 'history'], { pages: [{ items: [ROW] }], pageParams: [1] });
    await open();

    // (a) instantly
    for (const word of ['Checking your ride…', 'SW-1', 'Stabroek', 'Kitty']) expect(host.textContent).toContain(word);
    // (b) no amount, no rating, help held
    expect(host.textContent).not.toContain('GY$');
    expect(button('Send rating')).toBeUndefined();
    expect(button('Get help with this ride')!.disabled).toBe(true);

    // (c) the server's answer
    fx.read.resolve({ data: { data: finished } });
    await settle();
    expect(host.textContent).not.toContain('Checking your ride…');
    for (const word of ['Trip complete', 'Dan', 'GY$1,100']) expect(host.textContent).toContain(word);
    expect(button('Send rating')).toBeDefined();
    expect(button('Get help with this ride')!.disabled).toBe(false);
  });

  it('nothing in memory: the plain loading state, as before', async () => {
    await open();
    expect(host.textContent).toContain('loading');
    expect(host.textContent).not.toContain('Stabroek');
  });

  it('a failed read never shows the row as the ride', async () => {
    client.setQueryData(['customer', 'orders', 'live'], { items: [ROW], total: 1 });
    await open();
    expect(host.textContent).toContain('Stabroek');
    fx.read.reject(new Error('Network Error'));
    await settle();
    expect(host.textContent).toContain('failed');
    expect(host.textContent).not.toContain('Stabroek');
  });
});
