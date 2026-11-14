import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [STORE-BOARD S1 · parity audit 14 Nov 2026, A1] The store app's live board read GET /vendor/orders with no page
// size: the newest 20 orders of ANY status. With 20 newer orders behind it, an order still cooking or out for
// delivery silently left the board. Driven through the REAL useVendorOrders query function: the board now reads
// every open order (GET /vendor/orders/open), says when the server left any out, and — against a server that does
// not have the open read yet (404) — falls back to the newest 50 and says older open orders may be missing.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  open: vi.fn(),
  orders: vi.fn(),
}));

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
  vendorApi: { openOrders: (...a: unknown[]) => fx.open(...a), orders: (...a: unknown[]) => fx.orders(...a) },
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

import { useVendorOrders } from './vendorops';
import { openBoardNote } from '../modules/vendor/openBoard';
import { useOpenBoardMeta } from '../stores/openBoardMeta';

type Q = { queryKey: unknown[]; queryFn: () => Promise<Array<{ id: string; status: string }>> };
const rows = (n: number, status: string, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, status }));
const answer = (data: unknown[], meta: unknown) => Promise.resolve({ data: { success: true, data, meta } });

beforeEach(() => {
  fx.open.mockReset();
  fx.orders.mockReset();
  useOpenBoardMeta.setState({ meta: null });
});

describe('[STORE-BOARD S1] the app board reads every open order', () => {
  it('reads GET /vendor/orders/open, never the newest-20 page: 60 open orders all reach the board', async () => {
    const open = [...rows(30, 'PREPARING', 'p'), ...rows(30, 'PICKED_UP', 'd')];
    fx.open.mockReturnValue(answer(open, { total: 60, shown: 60, notShown: 0, cap: 300 }));
    const q = useVendorOrders(true) as unknown as Q;
    expect(q.queryKey).toEqual(['vendor', 'orders']); // every board consumer reads this key
    const data = await q.queryFn();
    expect(fx.open).toHaveBeenCalledTimes(1);
    expect(fx.orders).not.toHaveBeenCalled();
    expect(data).toHaveLength(60);
    expect(data.map((o) => o.id)).toEqual(open.map((o) => o.id));
    expect(openBoardNote(useOpenBoardMeta.getState().meta)).toBeNull();
  });

  it('past the server\'s cap the board says how many open orders it is not showing', async () => {
    fx.open.mockReturnValue(answer(rows(300, 'ACCEPTED', 'a'), { total: 304, shown: 300, notShown: 4, cap: 300 }));
    const data = await (useVendorOrders(true) as unknown as Q).queryFn();
    expect(data).toHaveLength(300);
    expect(openBoardNote(useOpenBoardMeta.getState().meta)).toBe('4 more open orders are not shown (300 of 304 shown).');
  });

  it('a server without the open read (404): the newest 50, and a note when older open orders may be missing', async () => {
    fx.open.mockReturnValue(Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 } })));
    fx.orders.mockReturnValue(answer(rows(50, 'PREPARING', 'x'), { total: 75, page: 1, limit: 50 }));
    const data = await (useVendorOrders(true) as unknown as Q).queryFn();
    expect(fx.orders).toHaveBeenCalledWith({ limit: 50 });
    expect(data).toHaveLength(50);
    expect(openBoardNote(useOpenBoardMeta.getState().meta)).toBe('Showing the newest 50 orders — older open orders may not be shown.');
  });

  it('any other failure is the board\'s error (never silently the short page)', async () => {
    fx.open.mockReturnValue(Promise.reject(Object.assign(new Error('boom'), { response: { status: 500 } })));
    await expect((useVendorOrders(true) as unknown as Q).queryFn()).rejects.toThrow('boom');
    expect(fx.orders).not.toHaveBeenCalled();
  });
});
