/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-SPEED C · report item 9] The driver Home map and board.
//  - The map was a CONTROLLED region rebuilt on every draw: each location tick, demand poll or sheet change snapped it
//    back over the driver's own pan or zoom. It now opens on the driver (initialRegion), moves once when the first
//    position arrives, and again only on Recentre.
//  - The location store is read field by field (a change Home does not show never redraws it).
//  - The board's Accept: only the tapped row shows "Checking acceptance…"; every other Accept waits, disabled (one
//    accept at a time, as before).
// The REAL screen in a real React renderer; the map is a stand-in that records its props and camera moves.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  kind: 'DRIVER' as 'DRIVER' | 'RIDER',
  online: true,
  demand: {} as any,
  jobs: [] as any[],
  active: null as any,
  snapToIndex: vi.fn(),
  toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() },
  goOnline: vi.fn(),
  loc: { latitude: 6.81 as number | null, longitude: -58.15 as number | null, status: 'granted', address: 'Somewhere' },
  wholeStoreReads: 0,
  map: { props: null as any, animate: vi.fn() },
  accept: { mutate: vi.fn(), isPending: false, variables: undefined as unknown },
}));

// The push-off strip (main since this test was written) reads AppState; it is not what this test is about.
vi.mock('../../../components/PushOffStrip', () => ({ PushOffStrip: () => null }));
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
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    __esModule: true,
    // Records what the screen hands the map, and the camera moves it asks for.
    default: R.forwardRef((p: any, ref: any) => {
      fx.map.props = p;
      R.useImperativeHandle(ref, () => ({ animateToRegion: fx.map.animate }));
      return h('div', { 'data-map': '' }, p.children);
    }),
    // A marker is "tappable" only if it carries a handler: exactly what the device does.
    Marker: (p: any) => h('div', { 'data-marker': p.title ?? 'demand', 'data-tappable': p.onPress ? 'true' : 'false', onClick: p.onPress }, p.children),
    PROVIDER_DEFAULT: 'default',
  };
});
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  const Sheet = R.forwardRef((p: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({ snapToIndex: fx.snapToIndex }));
    return R.createElement('section', null, p.children);
  });
  return { __esModule: true, default: Sheet, BottomSheetScrollView: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const T = (p: any) => h('span', a11y(p), p.children);
  return {
    T, Screen: (p: any) => h('div', null, p.children), ErrorState: () => null, LoadingBlock: () => null, Pictogram: () => null,
    TonePill: (p: any) => h('span', null, p.label), cardShadow: {},
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, 'data-loading': p.loading ? 'true' : 'false', disabled: !!p.disabled || !!p.loading, onClick: p.onPress }, p.label),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: fx.toast }));
vi.mock('../../../hooks', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });
  return {
    useMoverKind: () => ({ kind: fx.kind, profile: { isOnline: fx.online }, loading: false, error: null, ambiguous: false, refetch: vi.fn() }),
    useMoverStats: () => ({ data: null }),
    useEarningsToday: () => ({ data: { total: 0 } }),
    useDailyEarnings: () => ({ data: [] }),
    useDemand: () => ({ data: fx.demand }),
    useAvailableJobs: () => ({ data: fx.jobs }),
    useDispatchOffers: () => ({ offer: null, queuedBehind: 0, dismiss: vi.fn() }),
    useActiveJob: () => ({ data: fx.active, refetch: vi.fn() }),
    useActiveJobs: () => ({ legs: [], run: null }),
    useGoOnline: () => ({ ...mutation(), mutateAsync: fx.goOnline }),
    useGoOffline: mutation, useAcceptJob: () => fx.accept, useAcceptOffer: mutation, useDeclineOffer: mutation, useSelectMoverKind: mutation,
    useVerificationStatus: () => ({ data: null }),
    useEarnerPrefetch: () => undefined, // [SPEED 30 Oct] Home reads Earnings ahead (hooks/earnerPrefetch)
  };
});
vi.mock('../../../stores/locationStore', async () => {
  const R = await import('react');
  // A store that answers selectors like zustand's: a component redraws only when what it selected changed.
  const listeners = new Set<() => void>();
  const useLocationStore = Object.assign((select?: (s: typeof fx.loc) => unknown) => {
    if (!select) fx.wholeStoreReads += 1;
    const read = () => (select ? select(fx.loc) : fx.loc);
    return R.useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, read, read);
  }, { getState: () => fx.loc, setState: (next: Partial<typeof fx.loc>) => { fx.loc = { ...fx.loc, ...next }; listeners.forEach((l) => l()); } });
  return { useLocationStore };
});
vi.mock('../../../stores/authStore', () => ({ requireAuthSessionSnapshot: vi.fn() }));
vi.mock('../../../hooks/useDeviceLocation', () => ({ GEORGETOWN: { latitude: 6.8013, longitude: -58.1553 }, useDeviceLocation: () => ({ resolve: vi.fn() }) }));
vi.mock('../../../services/backgroundLocation', () => ({ requestMoverBackgroundPermission: vi.fn() }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: false }) }));
vi.mock('./MoverHomeAccountButton', () => ({ MoverHomeAccountButton: () => null }));
vi.mock('./BackgroundLocationDisclosure', () => ({ useBackgroundLocationDisclosure: () => ({ disclosure: null, disclose: vi.fn() }) }));
vi.mock('../RelayTasks', () => ({ RelayTasks: () => null }));
// [RINGER #1782] Once the offer card rings, its ring is unit-tested on its own; this file never draws an offer.
vi.mock('../../../hooks/useJobRing', () => ({ useJobRing: () => undefined }));
vi.mock('../../../hooks/mover', () => ({ useTaxiStopAction: () => ({ mutate: vi.fn(), isPending: false }) }));

import { useLocationStore } from '../../../stores/locationStore';
import { MoverHomeScreen } from './MoverHomeScreen';
import { MOVER_CAMERA_DELTA, MOVER_CAMERA_SOUTH } from '../../../lib/moverHomeMap';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const setLoc = async (next: Partial<{ latitude: number | null; longitude: number | null; address: string }>) => {
  await act(async () => { (useLocationStore as any).setState(next); });
};
async function draw() {
  await act(async () => root.render(React.createElement(MoverHomeScreen, { navigation: { navigate: vi.fn() } })));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const camera = (latitude: number, longitude: number) => ({
  latitude: latitude - MOVER_CAMERA_SOUTH, longitude, latitudeDelta: MOVER_CAMERA_DELTA, longitudeDelta: MOVER_CAMERA_DELTA,
});
const recentreButton = () => host.querySelector('[aria-label="Recentre the map on your position"]') as HTMLElement | null;

beforeEach(() => {
  vi.clearAllMocks();
  fx.kind = 'DRIVER'; fx.online = true; fx.demand = {}; fx.jobs = []; fx.active = null;
  fx.loc = { latitude: 6.81, longitude: -58.15, status: 'granted', address: 'Somewhere' };
  fx.wholeStoreReads = 0;
  fx.map = { props: null, animate: vi.fn() };
  fx.accept = { mutate: vi.fn(), isPending: false, variables: undefined };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[APP-SPEED C · item 9] the map is never pulled back by a redraw', () => {
  it('opens on the driver (initialRegion, no controlled region); later fixes and redraws never move it', async () => {
    await draw();
    expect(fx.map.props.region, 'no controlled region: a redraw cannot snap the camera').toBeUndefined();
    expect(fx.map.props.initialRegion).toEqual(camera(6.81, -58.15));
    await setLoc({ latitude: 6.82, longitude: -58.16 });
    await setLoc({ latitude: 6.83, longitude: -58.17 });
    await draw();
    expect(fx.map.animate, 'the driver’s own pan and zoom stay').not.toHaveBeenCalled();
    expect(fx.map.props.initialRegion, 'the opening camera is kept').toEqual(camera(6.81, -58.15));
  });

  it('no position at first: opens on Georgetown, moves ONCE when the first position arrives, never again', async () => {
    fx.loc = { ...fx.loc, latitude: null, longitude: null };
    await draw();
    expect(fx.map.props.initialRegion).toEqual(camera(6.8013, -58.1553));
    expect(recentreButton(), 'nothing to recentre on yet').toBeNull();
    await setLoc({ latitude: 6.81, longitude: -58.15 });
    expect(fx.map.animate).toHaveBeenCalledTimes(1);
    expect(fx.map.animate).toHaveBeenCalledWith(camera(6.81, -58.15), 400);
    await setLoc({ latitude: 6.82, longitude: -58.16 });
    await setLoc({ latitude: 6.83, longitude: -58.17 });
    expect(fx.map.animate).toHaveBeenCalledTimes(1);
  });

  it('Recentre moves the map back to the driver’s latest position', async () => {
    await draw();
    await setLoc({ latitude: 6.84, longitude: -58.18 });
    await act(async () => { recentreButton()!.click(); });
    expect(fx.map.animate).toHaveBeenCalledWith(camera(6.84, -58.18), 400);
  });

  it('reads the location store field by field: a change Home does not show never redraws it', async () => {
    await draw();
    expect(fx.wholeStoreReads, 'no whole-store read').toBe(0);
    const before = fx.map.props;
    await setLoc({ address: 'Somewhere else' });
    expect(fx.map.props, 'the screen did not draw again').toBe(before);
  });
});

describe('[APP-SPEED C · item 9] the board: only the tapped row waits for its accept', () => {
  const jobs = [
    { id: 'job-1', pickupAddress: 'Bourda Market', dropoffAddress: 'Kitty', fareTotal: 1800, paymentMethod: 'CASH' },
    { id: 'job-2', pickupAddress: 'Stabroek', dropoffAddress: 'Campbellville', fareTotal: 2200, paymentMethod: 'CASH' },
  ];
  const buttons = () => Array.from(host.querySelectorAll('button')).filter((b) => /^(Accept|Checking acceptance…)$/.test(b.textContent ?? ''));

  it('job-2’s accept out: job-2 shows the wait; job-1 says Accept but waits too (disabled)', async () => {
    fx.jobs = jobs;
    fx.accept = { mutate: vi.fn(), isPending: true, variables: { id: 'job-2' } };
    await draw();
    const [one, two] = buttons();
    expect([one!.textContent, one!.getAttribute('data-loading'), one!.disabled]).toEqual(['Accept', 'false', true]);
    expect([two!.textContent, two!.getAttribute('data-loading'), two!.disabled]).toEqual(['Checking acceptance…', 'true', true]);
    expect(host.textContent!.match(/Keep this screen open/g)?.length, 'the wait is said once, on its row').toBe(1);
  });

  it('nothing out: every Accept is free', async () => {
    fx.jobs = jobs;
    await draw();
    expect(buttons().map((b) => [b.textContent, b.disabled])).toEqual([['Accept', false], ['Accept', false]]);
    await act(async () => { buttons()[0]!.click(); });
    expect(fx.accept.mutate.mock.calls[0]![0]).toMatchObject({ id: 'job-1' });
  });
});
