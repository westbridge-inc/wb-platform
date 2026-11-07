import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF partner #2] A job step's button waits for the job, not for every
// mover read.
//
// TanStack Query awaits the promise a mutation's onSuccess (or onSettled)
// returns before the mutation counts as done: the button keeps spinning and
// the screen's own onSuccess (dismiss the offer card, move to the next step)
// waits. Each job step returned the refetch of EVERY mounted mover read, and
// Home stays mounted under the job screen: both profile probes (which retry
// twice), today's and the week's earnings, demand, the job board. So the
// button spun until the slowest of them answered, though the step itself had
// already succeeded. Now it waits for the active job (what the screen shows
// next); the other reads still refresh at once, in the background.
//
// Driven through the REAL hooks' options against a REAL query client: a
// mounted "profile" read that never answers must not hold the step.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...real,
    useMutation: (options: unknown) => options,
    useQuery: (options: unknown) => options,
    useQueryClient: () => fx.qc,
  };
});
vi.mock('../services/api', () => ({
  authApi: {}, customerApi: {}, driverApi: {}, riderApi: {}, rideApi: {},
}));
vi.mock('../stores/moverPreview', () => ({
  useMoverPreview: (selector: (state: { preview: boolean; kind: string }) => unknown) => selector({ preview: false, kind: 'DRIVER' }),
}));
vi.mock('../stores/locationStore', () => ({ useLocationStore: vi.fn() }));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({}),
  getAuthSessionSnapshot: () => null,
  requireAuthSessionSnapshot: () => null,
  requireAuthSessionForPrincipal: () => null,
  AuthSessionBoundaryError: class extends Error {},
}));
vi.mock('../services/backgroundLocation', () => ({ startMoverLocation: vi.fn(), stopMoverLocation: vi.fn() }));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: vi.fn() }));
vi.mock('../services/devicePosition', () => ({ currentDevicePosition: vi.fn() }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/uploadImage', () => ({ prepareUploadImage: vi.fn() }));
vi.mock('../lib/deviceLocation', () => ({
  commitLiveDeviceLocation: vi.fn(),
  createLiveDeviceLocationLease: vi.fn(),
  isLiveDeviceLocationLeaseValid: vi.fn(),
}));
vi.mock('../lib/moverLocation', () => ({ sharedMoverLocationController: {} }));
vi.mock('../lib/moverPreviewData', () => ({ previewMutation: vi.fn(), previewQuery: vi.fn() }));
vi.mock('../lib/moverProfile', () => ({ resolveMoverProfile: vi.fn(), unwrapOptionalMoverProfile: vi.fn() }));
vi.mock('../lib/moverAuthorityCache', () => ({ canonicalMoverAuthority: vi.fn() }));
vi.mock('../services/notification-priming', () => ({ maybePrimeNotifications: vi.fn() }));
vi.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, getLastKnownPositionAsync: vi.fn(), getCurrentPositionAsync: vi.fn() }));

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  refreshAfterJobStep,
  useAcceptJob,
  useAcceptOffer,
  useDriverAction,
  useRiderAction,
  useTaxiStopAction,
} from './mover';

type Step = { onSuccess?: (...args: unknown[]) => unknown; onSettled?: (...args: unknown[]) => unknown };

/** The mover's reads as Home + the job screen mount them. Each answers at
 *  once the first time; on the refresh the driver profile is held until
 *  `release` (a slow or retrying read), the others answer at once. */
async function mountMoverReads() {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const active = vi.fn(async () => ({ id: 'ride-1', status: 'ARRIVED' }));
  const profile = vi.fn(async () => {
    if (profile.mock.calls.length > 1) await held;
    return { id: 'driver-1' };
  });
  const earnings = vi.fn(async () => ({ total: 0 }));
  const observers = [
    new QueryObserver(fx.qc, { queryKey: ['mover', 'active', 'DRIVER'], queryFn: active }),
    new QueryObserver(fx.qc, { queryKey: ['mover', 'driverProfile'], queryFn: profile }),
    new QueryObserver(fx.qc, { queryKey: ['mover', 'earnings', 'DRIVER'], queryFn: earnings }),
  ];
  const unsubscribe = observers.map((o) => o.subscribe(() => {}));
  await vi.waitFor(() => {
    expect(fx.qc.getQueryData(['mover', 'active', 'DRIVER'])).toBeDefined();
    expect(fx.qc.getQueryData(['mover', 'driverProfile'])).toBeDefined();
    expect(fx.qc.getQueryData(['mover', 'earnings', 'DRIVER'])).toBeDefined();
  });
  return { release, active, profile, earnings, stop: () => unsubscribe.forEach((u) => u()) };
}

/** Did `promise` settle within a few macrotasks (the active read is instant)? */
async function settlesSoon(promise: unknown): Promise<boolean> {
  let done = false;
  void Promise.resolve(promise).then(() => { done = true; });
  for (let i = 0; i < 20 && !done; i++) await new Promise((r) => setTimeout(r, 0));
  return done;
}

beforeEach(() => {
  fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  fx.qc.clear();
});

describe('a job step waits for the active job only (PERF partner #2)', () => {
  it('refreshAfterJobStep settles once the active job is re-read, while a slow mover read is still out, and still refreshes every read', async () => {
    const reads = await mountMoverReads();
    const wait = refreshAfterJobStep(fx.qc);
    expect(await settlesSoon(wait)).toBe(true);
    expect(reads.active).toHaveBeenCalledTimes(2);
    expect(reads.profile).toHaveBeenCalledTimes(2); // asked again, still out
    expect(reads.earnings).toHaveBeenCalledTimes(2);
    reads.release();
    reads.stop();
  });

  // [APP-SPEED 7 · 7 Nov 2026] Each step re-reads what it changes: a step in the middle of a job the job alone, a
  // step that ends one every mover read (in the background). [APP-SPEED 6] An accept is free at the server's yes:
  // the job and the board re-read in the background while the job screen opens.
  type Scope = 'the job alone' | 'every mover read' | 'accept: free at the answer';
  const steps: Array<[string, () => Step, 'onSuccess' | 'onSettled', unknown[], Scope]> = [
    ['accept a dispatch offer', () => useAcceptOffer('DRIVER') as unknown as Step, 'onSuccess', [{}, { orderId: 'ride-1' }], 'accept: free at the answer'],
    ['accept from the job board', () => useAcceptJob('RIDER') as unknown as Step, 'onSuccess', [{}, { id: 'order-1' }], 'accept: free at the answer'],
    ['a driver step (arrived)', () => useDriverAction() as unknown as Step, 'onSuccess', [{}, { id: 'ride-1', action: 'arrived' }], 'the job alone'],
    ['a driver step (fare handover)', () => useDriverAction() as unknown as Step, 'onSuccess', [{}, { id: 'ride-1', action: 'handover', outcome: 'paid' }], 'every mover read'],
    ['a rider step (picked up)', () => useRiderAction() as unknown as Step, 'onSuccess', [{}, { id: 'order-1', action: 'picked-up' }], 'the job alone'],
    ['a taxi stop action', () => useTaxiStopAction() as unknown as Step, 'onSettled', [{}, null, { id: 'ride-1', sequence: 1, action: 'arrived' }], 'the job alone'],
  ];

  for (const [name, hook, callback, args, scope] of steps) {
    it(`${name}: re-reads ${scope.startsWith('accept') ? 'the job and the board' : scope}, never waits for the slowest mover read`, async () => {
      const reads = await mountMoverReads(); // the profile's refresh is held
      const options = hook();
      const returned = options[callback]!(...args);
      if (scope === 'accept: free at the answer') {
        expect(returned, 'the accept is free at the server\'s yes').toBeUndefined();
        await vi.waitFor(() => expect(reads.active).toHaveBeenCalledTimes(2));
      } else {
        expect(returned).toBeInstanceOf(Promise); // still awaited: the screen shows the new job state
        expect(await settlesSoon(returned)).toBe(true);
        expect(reads.active).toHaveBeenCalledTimes(2);
      }
      const others = scope === 'every mover read' ? 2 : 1;
      expect(reads.profile, 'the profile is re-read only when a job ends').toHaveBeenCalledTimes(others);
      expect(reads.earnings, 'the earnings are re-read only when a job ends').toHaveBeenCalledTimes(others);
      reads.release();
      reads.stop();
    });
  }
});
