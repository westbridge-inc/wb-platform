/// <reference lib="dom" />
// [APP-SPEED 6 · 7 Nov 2026] An accept lands the driver or rider on the job at the server's yes. The REAL
// MoverHomeScreen (the same stand-ins as MoverHome.deliveryCard.navigation.test.ts): the accept is a stand-in whose
// answer each case gives by hand. Asserted: nothing moves before the answer; the server's yes opens ActiveJob with the
// accepted order id and the answer's moment (ActiveJob shows it loading, not "No active job"); a refusal opens
// nothing; a delivery card answered in taxi mode, and a stacked rider's new leg, keep today's screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

const fx = vi.hoisted(() => ({
  jobs: [] as any[], offer: null as any, kind: 'DRIVER' as 'DRIVER' | 'RIDER', active: null as any,
  accept: { DRIVER: vi.fn(), RIDER: vi.fn() }, grab: vi.fn(), decline: { DRIVER: vi.fn(), RIDER: vi.fn() }, dismiss: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../../../hooks/useJobRing', () => ({ useJobRing: vi.fn() }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return { View, Pressable, Text: View, StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 }, Platform: { OS: 'ios' } };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../../components/PushOffStrip', () => ({ PushOffStrip: () => null }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('div', null, p.children), Marker: () => null, PROVIDER_DEFAULT: 'default' };
});
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('section', null, p.children), BottomSheetScrollView: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const T = (p: any) => h('span', { 'data-testid': p.testID }, p.children);
  return {
    T, Screen: (p: any) => h('div', null, p.children), ErrorState: () => null, LoadingBlock: () => null, Pictogram: () => null,
    TonePill: (p: any) => h('span', null, p.label), cardShadow: {},
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }, p.label),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });
  return {
    useMoverKind: () => ({ kind: fx.kind, profile: { isOnline: true }, loading: false, error: null, ambiguous: false, dual: true, refetch: vi.fn() }),
    useMoverStats: () => ({ data: null }),
    useEarningsToday: () => ({ data: { total: 0 } }),
    useDailyEarnings: () => ({ data: [] }),
    useDemand: () => ({ data: {} }),
    useAvailableJobs: () => ({ data: fx.jobs, dataUpdatedAt: Date.now() }),
    useDispatchOffers: () => ({ offer: fx.offer, queuedBehind: 0, dismiss: fx.dismiss }),
    useActiveJob: () => ({ data: fx.active }),
    useActiveJobs: () => ({ legs: [], run: null }),
    useEarnerPrefetch: () => undefined, // [SPEED 30 Oct] Home reads Earnings ahead (hooks/earnerPrefetch)
    useGoOnline: mutation, useGoOffline: mutation, useAcceptJob: () => ({ mutate: fx.grab, isPending: false }),
    useAcceptOffer: (k: 'DRIVER' | 'RIDER') => ({ mutate: fx.accept[k], isPending: false }),
    useDeclineOffer: (k: 'DRIVER' | 'RIDER') => ({ mutateAsync: (...a: unknown[]) => { fx.decline[k](...a); return Promise.resolve(null); }, isPending: false }),
    useSelectMoverKind: mutation,
    useVerificationStatus: () => ({ data: null }),
  };
});
vi.mock('../../../stores/locationStore', () => {
  const state = { latitude: 6.81, longitude: -58.15, status: 'granted' };
  // [APP-SPEED C] Home reads the store field by field (selectors).
  return { useLocationStore: Object.assign((select?: (s: typeof state) => unknown) => (select ? select(state) : state), { getState: () => state }) };
});
vi.mock('../../../stores/authStore', () => ({ requireAuthSessionSnapshot: vi.fn() }));
vi.mock('../../../hooks/useDeviceLocation', () => ({ GEORGETOWN: { latitude: 6.8013, longitude: -58.1553 }, useDeviceLocation: () => ({ resolve: vi.fn() }) }));
vi.mock('../../../services/backgroundLocation', () => ({ requestMoverBackgroundPermission: vi.fn() }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: false }) }));
vi.mock('../RelayTasks', () => ({ RelayTasks: () => null }));
vi.mock('./MoverHomeAccountButton', () => ({ MoverHomeAccountButton: () => null }));
vi.mock('./BackgroundLocationDisclosure', () => ({ useBackgroundLocationDisclosure: () => ({ disclosure: null, disclose: vi.fn() }) }));
vi.mock('../../../hooks/mover', () => ({ useTaxiStopAction: () => ({ mutate: vi.fn(), isPending: false }) }));

import { MoverHomeScreen } from './MoverHomeScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function draw() {
  await act(async () => root.render(React.createElement(MoverHomeScreen, { navigation: { navigate: fx.navigate } })));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const press = async (label: string) => {
  const b = Array.from(host.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === label);
  if (!b) throw new Error(`no button ${label}: ${Array.from(host.querySelectorAll('button')).map((x) => x.getAttribute('aria-label')).join('|')}`);
  await act(async () => { b.click(); });
};
type Handlers = { onSuccess?: (...a: unknown[]) => void; onError?: (...a: unknown[]) => void };
const handlersOf = (m: ReturnType<typeof vi.fn>) => (m.mock.calls.at(-1)?.[1] ?? {}) as Handlers;
const answer = async (m: ReturnType<typeof vi.fn>, kind: 'yes' | 'no') => {
  const h = handlersOf(m);
  await act(async () => { kind === 'yes' ? h.onSuccess?.({}, m.mock.calls.at(-1)?.[0]) : h.onError?.(new Error('taken'), m.mock.calls.at(-1)?.[0]); });
};
const opened = () => fx.navigate.mock.calls.filter(([screen]) => screen === 'ActiveJob');

beforeEach(() => {
  vi.clearAllMocks();
  fx.jobs = []; fx.offer = null; fx.kind = 'DRIVER'; fx.active = null;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[APP-SPEED 6] the offer card\'s Accept', () => {
  it('opens the job at the server\'s yes, with the accepted order and the answer\'s moment; nothing before it', async () => {
    fx.offer = { orderId: 'ride-1', offerAttemptId: 'a', orderType: 'TAXI', expiresInSeconds: 20 };
    await draw();
    await press('Accept ride');
    expect(fx.accept.DRIVER).toHaveBeenCalledTimes(1);
    expect(opened(), 'nothing opens before the server answers').toHaveLength(0);
    const before = Date.now();
    await answer(fx.accept.DRIVER, 'yes');
    expect(fx.dismiss).toHaveBeenCalledTimes(1);
    expect(opened()).toHaveLength(1);
    const params = opened()[0]![1] as { acceptedOrderId: string; acceptedAt: number };
    expect(params.acceptedOrderId).toBe('ride-1');
    expect(params.acceptedAt).toBeGreaterThanOrEqual(before);
  });

  it('a refusal (taken by another driver, the offer gone) opens nothing', async () => {
    fx.offer = { orderId: 'ride-1', offerAttemptId: 'a', orderType: 'TAXI', expiresInSeconds: 20 };
    await draw();
    await press('Accept ride');
    await answer(fx.accept.DRIVER, 'no');
    expect(opened()).toHaveLength(0);
    expect(fx.dismiss).not.toHaveBeenCalled();
  });

  it('a delivery card answered in taxi mode closes; the taxi job screen is not opened for it', async () => {
    fx.offer = { orderId: 'ord-food-1', offerAttemptId: 'att-1', orderType: 'FOOD_DELIVERY', expiresInSeconds: 25, deliveryFee: 800, tipAmount: 0, paymentMethod: 'CASH' };
    await draw();
    await press('Accept delivery');
    await answer(fx.accept.RIDER, 'yes');
    expect(fx.dismiss).toHaveBeenCalledTimes(1);
    expect(opened()).toHaveLength(0);
  });
});

describe('[APP-SPEED 6] the job board\'s Accept', () => {
  const row = { id: 'order-7', pickupAddress: 'Bourda', deliveryAddress: 'Kitty', deliveryFee: 600, paymentMethod: 'CASH', vendor: { name: 'Corner Shop' } };

  it('a rider with no job: the job opens at the server\'s yes, never before, never on a refusal', async () => {
    fx.kind = 'RIDER'; fx.jobs = [row];
    await draw();
    await press('Accept');
    expect(fx.grab).toHaveBeenCalledTimes(1);
    expect(opened()).toHaveLength(0);
    await answer(fx.grab, 'no');
    expect(opened()).toHaveLength(0);
    await press('Accept');
    await answer(fx.grab, 'yes');
    expect(opened()).toHaveLength(1);
    expect((opened()[0]![1] as { acceptedOrderId: string }).acceptedOrderId).toBe('order-7');
  });

  it('a stacked rider (already on a job): an offer\'s new leg joins the run on screen; nothing new opens', async () => {
    // Home shows the active run, not the board, while a rider is on a job: a stacked leg comes as an offer card.
    fx.kind = 'RIDER'; fx.active = { id: 'order-1', status: 'PICKED_UP' };
    fx.offer = { orderId: 'order-8', offerAttemptId: 'att-8', orderType: 'FOOD_DELIVERY', expiresInSeconds: 25, deliveryFee: 600, tipAmount: 0, paymentMethod: 'CASH' };
    await draw();
    await press('Accept delivery');
    await answer(fx.accept.RIDER, 'yes');
    expect(fx.dismiss).toHaveBeenCalledTimes(1);
    expect(opened()).toHaveLength(0);
  });
});
