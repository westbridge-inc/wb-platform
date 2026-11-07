import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [APP-SPEED 5 · 6 · 7 · 7 Nov 2026] The mover's buttons answer at the server's reply.
//
// Driven through the REAL hooks' options against a REAL query client (the same stand-ins as
// mover.jobStepWait.test.ts): what each callback returns is what TanStack Query waits for before the button
// is free, and what it writes is what the screen shows at the answer.
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
  authApi: {}, customerApi: {}, rideApi: {},
  driverApi: { goOffline: vi.fn(async () => ({ data: { data: { isOnline: false } } })) },
  riderApi: { goOffline: vi.fn(async () => ({ data: { data: { isOnline: false } } })) },
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
import { useAcceptOffer, useGoOffline, useRiderAction, writeJobEnded } from './mover';
import { bindMoverJobFeed } from '../lib/moverJobFeed';

type Step = { onSuccess?: (...args: unknown[]) => unknown; mutationFn?: (...args: unknown[]) => unknown };

beforeEach(() => { fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { fx.qc.clear(); });

async function observe(key: unknown[], answer: () => unknown) {
  const read = vi.fn(async () => answer());
  const off = new QueryObserver(fx.qc, { queryKey: key, queryFn: read }).subscribe(() => {});
  await vi.waitFor(() => expect(fx.qc.getQueryData(key)).toBeDefined());
  return { read, off };
}

describe('[APP-SPEED 6] an accept by a rider already on a job (stacking) keeps the wait', () => {
  it('the new leg joins the run on screen: the accept waits for the job\'s re-read', async () => {
    const job = await observe(['mover', 'active', 'RIDER'], () => ({ id: 'order-1', status: 'PICKED_UP' }));
    const returned = (useAcceptOffer('RIDER') as unknown as Step).onSuccess!({}, { orderId: 'order-2' });
    expect(returned).toBeInstanceOf(Promise);
    await returned;
    expect(job.read).toHaveBeenCalledTimes(2);
    job.off();
  });

  it('a rider with no job: free at the answer, the job and the board re-read in the background', async () => {
    const job = await observe(['mover', 'active', 'RIDER'], () => null);
    const board = await observe(['mover', 'available', 'RIDER'], () => []);
    const returned = (useAcceptOffer('RIDER') as unknown as Step).onSuccess!({}, { orderId: 'order-2' });
    expect(returned).toBeUndefined();
    await vi.waitFor(() => expect(job.read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(board.read).toHaveBeenCalledTimes(2));
    job.off(); board.off();
  });
});

describe('[APP-SPEED 5] going offline answers at the server\'s yes', () => {
  it('the profile says offline at the answer; the toggle is free; every mover read refreshes in the background', async () => {
    const profile = await observe(['mover', 'driverProfile'], () => ({ id: 'driver-1', isOnline: true, isAvailable: true }));
    const options = useGoOffline('DRIVER') as unknown as Step;
    const returned = options.onSuccess!({ isOnline: false });
    expect(returned).toBeUndefined();
    expect(fx.qc.getQueryData(['mover', 'driverProfile'])).toMatchObject({ isOnline: false, isAvailable: false });
    await vi.waitFor(() => expect(profile.read).toHaveBeenCalledTimes(2));
    profile.off();
  });

  it('a refused go-offline (a job is on) writes nothing: the mutation fails before onSuccess', async () => {
    const profile = await observe(['mover', 'riderProfile'], () => ({ id: 'rider-1', isOnline: true }));
    const { riderApi } = await import('../services/api') as unknown as { riderApi: { goOffline: ReturnType<typeof vi.fn> } };
    riderApi.goOffline.mockRejectedValueOnce(Object.assign(new Error('409'), { response: { status: 409 } }));
    const mutation = fx.qc.getMutationCache().build(fx.qc, useGoOffline('RIDER') as never);
    await expect(mutation.execute(undefined as never)).rejects.toBeTruthy();
    expect(fx.qc.getQueryData(['mover', 'riderProfile'])).toMatchObject({ isOnline: true });
    profile.off();
  });
});

describe('[APP-SPEED 7] a step\'s own answer is not re-read again when the room echoes it', () => {
  it('the step notes its answered status; the room\'s echo of it does not re-read the job', async () => {
    await observe(['mover', 'active', 'RIDER'], () => ({ id: 'order-9', status: 'RIDER_ASSIGNED' }));
    const handlers = new Map<string, (p?: unknown) => void>();
    const socket = { connected: true, emit() {}, on: (e: string, cb: (p?: unknown) => void) => { handlers.set(e, cb); }, off() {} };
    const refresh = vi.fn();
    const off = bindMoverJobFeed(socket, ['order-9'], refresh);
    (useRiderAction() as unknown as Step).onSuccess!({ orderId: 'order-9', status: 'RIDER_EN_ROUTE_PICKUP' }, { id: 'order-9', action: 'en-route-pickup' });
    handlers.get('order:status_changed')!({ orderId: 'order-9', status: 'RIDER_EN_ROUTE_PICKUP' });
    expect(refresh).not.toHaveBeenCalled();
    handlers.get('order:status_changed')!({ orderId: 'order-9', status: 'CANCELLED' });
    expect(refresh).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('[APP-SPEED 6] writeJobEnded writes only what the answer says', () => {
  it('only a finished status, for the job on screen, alone (not one leg of several)', async () => {
    fx.qc.setQueryData(['mover', 'active', 'RIDER'], { id: 'order-1', status: 'ARRIVED' });
    expect(writeJobEnded(fx.qc, 'order-1', { status: 'RETURNING' })).toBe(false);
    expect(writeJobEnded(fx.qc, 'order-1', {})).toBe(false);
    expect(writeJobEnded(fx.qc, 'order-2', { status: 'DELIVERED' })).toBe(false);
    expect(writeJobEnded(fx.qc, undefined, { status: 'DELIVERED' })).toBe(false);
    expect(fx.qc.getQueryData(['mover', 'active', 'RIDER'])).toEqual({ id: 'order-1', status: 'ARRIVED' });
    fx.qc.setQueryData(['mover', 'active', 'RIDER', 'legs'], { legs: [{ id: 'order-1' }, { id: 'order-3' }], run: null });
    expect(writeJobEnded(fx.qc, 'order-1', { status: 'DELIVERED' })).toBe(false);
    fx.qc.setQueryData(['mover', 'active', 'RIDER', 'legs'], { legs: [{ id: 'order-1' }], run: null });
    expect(writeJobEnded(fx.qc, 'order-1', { status: 'DELIVERED' })).toBe(true);
    expect(fx.qc.getQueryData(['mover', 'active', 'RIDER'])).toBeNull();
  });
});
