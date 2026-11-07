import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [APP-SPEED 5 · 7 Nov 2026] Saving an address is free at the server's answer: the saved address (the server's own
// row) is in the list at once, ordered as GET /addresses orders it, and the list re-reads in the background. The
// REAL hook's options against a REAL query client (the same environment stand-ins as customer.mmgClaim.test.ts).
// ---------------------------------------------------------------------------

const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return { previousApiUrl, qc: null as unknown as import('@tanstack/react-query').QueryClient };
});
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useMutation: (o: unknown) => o, useQuery: vi.fn(), useInfiniteQuery: vi.fn(), useQueryClient: () => env.qc };
});
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => null,
  isAuthSessionSnapshotCurrent: () => false,
  useAuthStore: { getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }) },
}));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: () => null, rememberMarketDepth: () => {} }));

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { customerKeys, listWithAddedAddress, useAddAddress } from './customer';

afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});
beforeEach(() => { env.qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });

const home = { id: 'a1', label: 'Home', isDefault: true };
const work = { id: 'a2', label: 'Work', isDefault: false };

describe('[APP-SPEED 5] the saved address is in the list at the answer', () => {
  it('free at the answer; the server\'s row joins the list; the list re-reads in the background', async () => {
    env.qc.setQueryData(customerKeys.addresses, [home, work]);
    const read = vi.fn(async () => [home, { id: 'a3', label: 'Gym', isDefault: false }, work]);
    const off = new QueryObserver(env.qc, { queryKey: customerKeys.addresses, queryFn: read, staleTime: Infinity }).subscribe(() => {});
    const returned = (useAddAddress() as unknown as { onSuccess: (a: unknown) => unknown }).onSuccess({ id: 'a3', label: 'Gym', isDefault: false });
    expect(returned, 'the Save button is not held for the re-read').toBeUndefined();
    expect(env.qc.getQueryData(customerKeys.addresses)).toEqual([home, { id: 'a3', label: 'Gym', isDefault: false }, work]);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    off();
  });

  it('orders it as the server does: a new default first (the others lose the flag), else newest after the default', () => {
    const gym = { id: 'a3', label: 'Gym', isDefault: false };
    expect(listWithAddedAddress([home, work], gym)).toEqual([home, gym, work]);
    expect(listWithAddedAddress([work], gym)).toEqual([gym, work]);
    expect(listWithAddedAddress([home], gym)).toEqual([home, gym]);
    expect(listWithAddedAddress([home, work], { ...gym, isDefault: true })).toEqual([
      { ...gym, isDefault: true }, { ...home, isDefault: false }, { ...work, isDefault: false },
    ]);
  });

  it('writes nothing it cannot place: no id (an older answer), already listed, or no list read yet', () => {
    expect(listWithAddedAddress([home], { label: 'x' })).toEqual([home]);
    expect(listWithAddedAddress([home, work], { ...work })).toEqual([home, work]);
    expect(listWithAddedAddress(undefined, { id: 'a3' })).toBeUndefined();
  });
});
