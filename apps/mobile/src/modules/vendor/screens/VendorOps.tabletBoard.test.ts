import { describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => {
  const token: unknown = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : token });
  return { token, orders: [] as unknown[], role: 'OWNER', columns: 1 as 1 | 2 | 4, awake: [] as boolean[] };
});
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const hooks = { useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, vi.fn()], useEffect: () => {} };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View' }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@swift/ui', () => ({ color: fx.token, elevation: fx.token, radius: fx.token, space: fx.token }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('../../../kit', () => Object.fromEntries(['Card', 'Chip', 'IconChip', 'LabeledInput', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'T', 'TonePill'].map((name) => [name, name])));
vi.mock('../../../kit/switch', () => ({ Switch: 'Switch' }));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: vi.fn() }));
vi.mock('../../../services/socket', () => ({ disconnectSocket: vi.fn() }));
vi.mock('../../../components/onboarding/DocumentUploadCard', () => ({ docLabel: () => '' }));
vi.mock('../../../hooks/verification', () => ({ useVerificationStatus: () => ({}) }));
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false }) }));
vi.mock('../../../hooks/useNavigationFocused', () => ({ useNavigationFocused: () => true }));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: (pick: (_s: unknown) => unknown) => pick({}) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: (pick: (_s: unknown) => unknown) => pick({}) }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (_s: unknown) => unknown) => pick({}) }));
vi.mock('../boardLayout', () => ({ useBoardColumns: () => fx.columns }));
vi.mock('../../../lib/keepAwake', () => ({ useKeepScreenAwake: (on: boolean) => { fx.awake.push(on); } }));
vi.mock('../../../hooks/vendorops', () => ({
  useVendorProfile: () => ({ stores: [], owner: { myRole: fx.role } }),
  useVendorSubscription: () => ({ data: {} }),
  ...Object.fromEntries(['useVendorOrderHistory', 'useToggleOpen', 'useToggleOrders', 'useSetSelfDelivery', 'useSetRequirePickupCode', 'useVendorMenu', 'useVendorQr', 'useVendorAnalytics', 'useVendorRevenue', 'useVendorOps', 'useVendorHours', 'useDeliveryStatus'].map((name) => [name, () => ({})])),
  useVendorOrders: () => ({ data: fx.orders, isLoading: false, isError: false }),
  useOrderAction: () => ({ mutate: vi.fn(), isPending: false }),
  usePendingOrderIds: () => new Set<string>(),
}));
vi.mock('../../../modules/vendor/shared', () => ({
  safeVendorRole: (role: string) => role,
  fmtDate: (date: string) => date.slice(0, 10),
  reconciledRevenueDays: () => [], windowTotals: () => ({}), numericFact: () => null,
  TYPES: {}, GUTTER: 0, TabHeader: 'TabHeader', DAY_LABELS: [], catalogueMeta: () => ({ label: 'Menu' }),
  BoardFirstRun: 'BoardFirstRun', BoardFirstRunRow: 'BoardFirstRunRow',
  orderActions: () => [],
  OrderStatusPill: 'OrderStatusPill', FulfillmentTag: 'FulfillmentTag', MmgDisputeNotice: 'MmgDisputeNotice', DeltaBadge: 'DeltaBadge',
  fmtClock: () => '', fmtWhen: () => '', formatSlot: () => '',
}));
import { VendorOps } from './VendorOps';

// ---------------------------------------------------------------------------
// [STORE-BOARD · parity audit 14 Nov 2026] The store app on a counter tablet:
//  - A2/A3: on a tablet the board is the website's lanes side by side (New, Preparing, Ready / handoff, Out for
//    delivery); a phone keeps its one list. The app stays portrait (changing the orientation needs a store build).
//  - A4: staff open finished orders: "Finished orders" (the order history) is a floor tool for every role.
//  - C4: the screen stays on while the board is on screen.
// The board is rendered by calling VendorOps with its hooks stubbed (the harness of VendorOps.boardWait.test.ts).
// ---------------------------------------------------------------------------

type El = { type: unknown; props: Record<string, any> & { children?: unknown; testID?: string; label?: string; onPress?: () => void; order?: any; busy?: boolean } };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as El;
  const kids = typeof element.props.children === 'function' ? element.props.children({ pressed: false }) : element.props.children;
  return [element, ...elements(kids)];
}
const order = (id: string, status: string) => ({ id, orderNumber: id.toUpperCase(), status, items: [], fulfillment: 'DELIVERY', paymentMethod: 'CASH' });
const navigation = { navigate: vi.fn(), isFocused: () => true };
const board = () => VendorOps({ store: { id: 'store-A', name: 'Test store', status: 'ACTIVE', isCurrentlyOpen: true, acceptingOrders: true, vendorType: 'RESTAURANT' }, navigation });
const lane = (tree: El[], key: string) => tree.find((e) => e.props.testID === `board-lane-${key}`);
const cardIds = (tree: El[]) => tree.filter((e) => e.props && typeof e.props.order === 'object' && e.props.order && 'busy' in e.props).map((e) => e.props.order.id);
const ORDERS = () => [order('n1', 'PENDING'), order('k1', 'PREPARING'), order('k2', 'ACCEPTED'), order('h1', 'READY_FOR_PICKUP'), order('m1', 'PICKED_UP')];

describe('[STORE-BOARD A2/A3] a tablet board is lanes side by side', () => {
  it('four lanes, each with its own orders, every order once', () => {
    fx.columns = 4;
    fx.orders = ORDERS();
    const tree = elements(board());
    expect(cardIds(elements(lane(tree, 'new')))).toEqual(['n1']);
    expect(cardIds(elements(lane(tree, 'kitchen'))).sort()).toEqual(['k1', 'k2']);
    expect(cardIds(elements(lane(tree, 'handoff')))).toEqual(['h1']);
    expect(cardIds(elements(lane(tree, 'moving')))).toEqual(['m1']);
    expect(cardIds(tree).sort()).toEqual(['h1', 'k1', 'k2', 'm1', 'n1']);
  });

  it('a phone keeps the one list (no lanes), every order still on it', () => {
    fx.columns = 1;
    fx.orders = ORDERS();
    const tree = elements(board());
    expect(lane(tree, 'new')).toBeUndefined();
    expect(cardIds(tree).sort()).toEqual(['h1', 'k1', 'k2', 'm1', 'n1']);
  });
});

describe('[STORE-BOARD A4] staff open finished orders', () => {
  const tiles = (tree: El[]) => {
    const staffTools = tree.find((e) => typeof e.type === 'function' && (e.type as { name?: string }).name === 'VendorStaffAvailability');
    expect(staffTools).toBeTruthy();
    return elements((staffTools!.type as (_p: unknown) => unknown)(staffTools!.props));
  };
  it('a staff login has "Finished orders", which opens the order history', () => {
    fx.role = 'STAFF';
    fx.columns = 1;
    fx.orders = ORDERS();
    navigation.navigate.mockClear();
    const tile = tiles(elements(board())).find((e) => e.props.label === 'Finished orders');
    expect(tile).toBeTruthy();
    tile!.props.onPress!();
    expect(navigation.navigate).toHaveBeenCalledWith('VendorOrderHistory');
    fx.role = 'OWNER';
  });
});

describe('[STORE-BOARD C4] the screen stays on while the board is on screen', () => {
  it('the board asks to keep the screen awake while it is shown', () => {
    fx.awake = [];
    fx.orders = ORDERS();
    board();
    expect(fx.awake).toEqual([true]);
  });
});
