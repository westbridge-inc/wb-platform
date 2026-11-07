import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED C · report item 9] The driver Home's demand dots no longer blink.
//
// The demand read is keyed on the driver's position rounded to 3 decimals (about 110 m): driving across that line
// made a new key with no data, so every dot vanished until the new answer landed, then came back. The last answer of
// the SAME kind of work now stays on the map (flagged as placeholder) while the new one is read; a switch between
// taxi and delivery work never shows the other kind's demand. Driven through the REAL hook's query options and a
// real query observer (one observer whose options change, as a mounted screen's does).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient, demand: vi.fn() }));

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
  driverApi: { demand: (point: unknown) => fx.demand('DRIVER', point) },
  riderApi: { demand: (point: unknown) => fx.demand('RIDER', point) },
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

import { useDemand } from './mover';

const A = { lat: 6.8101, lng: -58.1501 };
const B = { lat: 6.8131, lng: -58.1531 }; // ~400 m on: another rounded key
// useQuery is replaced by its options (above): calling the hook outside a component only reads them.
const options = (kind: 'DRIVER' | 'RIDER', point: { lat: number; lng: number }) => {
  const readDemandOptions = useDemand;
  const o = readDemandOptions(kind, point) as any;
  return { ...o, refetchInterval: false };
};

async function observe() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fx.qc = qc;
  const observer = new QueryObserver(qc, options('DRIVER', A));
  const stop = observer.subscribe(() => undefined);
  await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
  return { qc, observer, stop };
}

describe('[APP-SPEED C] the demand dots across a rounded-position change', () => {
  it('the same kind of work: the last answer stays (placeholder) while the new key is read, then the new answer', async () => {
    let answerB!: (v: unknown) => void;
    fx.demand.mockReset();
    fx.demand.mockResolvedValueOnce({ data: { data: { waiting: 3, points: [{ lat: 6.81, lng: -58.15 }] } } })
      .mockImplementationOnce(() => new Promise((resolve) => { answerB = resolve; }));
    const { observer, stop } = await observe();
    observer.setOptions(options('DRIVER', B));
    const during = observer.getCurrentResult();
    expect(during.data, 'the dots stay while the new area is read').toEqual({ waiting: 3, points: [{ lat: 6.81, lng: -58.15 }] });
    expect(during.isPlaceholderData).toBe(true);
    answerB({ data: { data: { waiting: 1, points: [] } } });
    await vi.waitFor(() => expect(observer.getCurrentResult().isPlaceholderData).toBe(false));
    expect(observer.getCurrentResult().data).toEqual({ waiting: 1, points: [] });
    stop();
  });

  it('another kind of work never shows this kind\'s demand', async () => {
    fx.demand.mockReset();
    fx.demand.mockResolvedValueOnce({ data: { data: { waiting: 3 } } }).mockImplementation(() => new Promise(() => {}));
    const { observer, stop } = await observe();
    observer.setOptions(options('RIDER', A));
    expect(observer.getCurrentResult().data).toBeUndefined();
    stop();
  });
});
