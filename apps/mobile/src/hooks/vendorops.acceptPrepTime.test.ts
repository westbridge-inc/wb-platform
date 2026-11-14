import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [APP-PREPTIME · owner 14 Nov 2026] The store's Accept on the phone/tablet
// sends the preparation time the staff chose, exactly like the website. Driven
// through the REAL useOrderAction mutation function: the minutes reach
// vendorApi.acceptOrder; a tap with none (a booking) sends none.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ accepted: [] as unknown[][] }));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return { ...real, useEffect: vi.fn(), useState: (v: unknown) => [v, vi.fn()], useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(), useRef: (v: unknown) => ({ current: v }) };
});
vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => ({}) };
});
vi.mock('../services/api', () => ({
  vendorApi: { acceptOrder: (...args: unknown[]) => { fx.accepted.push(args); return Promise.resolve({ data: { success: true, data: { id: args[0], status: 'PREPARING' } } }); } },
  vendorDiscoveryApi: {},
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({}),
  getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: () => null, requireAuthSessionSnapshot: () => null,
}));
vi.mock('../lib/billingMutation', () => ({ runBillingMutation: vi.fn() }));
vi.mock('./cashSettlement', () => ({ confirmVendorCashSettlement: vi.fn() }));
vi.mock('./partnerPricing', () => ({ usePartnerPricing: vi.fn() }));
vi.mock('./useVendorMutation', () => ({ guardVendorOperation: vi.fn(), useVendorMutation: (options: unknown) => options }));
vi.mock('../lib/vendorPreviewData', () => ({
  vendorPreviewDataset: () => null, vendorPreviewSubscription: () => null, previewQuery: vi.fn(), previewMutation: vi.fn(), VENDOR_PREVIEW_MARKET: {},
}));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: () => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }) }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: Object.assign(() => ({}), { getState: () => ({ selectedStoreId: 'store-a' }) }) }));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (selector: (s: { previewType: null }) => unknown) => selector({ previewType: null }) }));

import { useOrderAction } from './vendorops';

type Run = { mutationFn: (vars: { id: string; action: 'accept'; prepMinutes?: number }) => Promise<unknown> };

beforeEach(() => { fx.accepted.length = 0; });

describe('[APP-PREPTIME] the store app\'s Accept sends the chosen minutes', () => {
  it('45 chosen: acceptOrder(id, 45)', async () => {
    const { mutationFn } = useOrderAction() as unknown as Run;
    await mutationFn({ id: 'o1', action: 'accept', prepMinutes: 45 });
    expect(fx.accepted).toEqual([['o1', 45]]);
  });

  it('the default 20: acceptOrder(id, 20)', async () => {
    const { mutationFn } = useOrderAction() as unknown as Run;
    await mutationFn({ id: 'o2', action: 'accept', prepMinutes: 20 });
    expect(fx.accepted).toEqual([['o2', 20]]);
  });

  it('none (a booking): acceptOrder(id) with no minutes', async () => {
    const { mutationFn } = useOrderAction() as unknown as Run;
    await mutationFn({ id: 'o3', action: 'accept' });
    expect(fx.accepted).toEqual([['o3', undefined]]);
  });
});
