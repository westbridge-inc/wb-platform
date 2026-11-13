import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  vendor: {} as Record<string, any>,
  params: {} as Record<string, any>,
  mutate: vi.fn(),
  addState: { isPending: false, isError: false, error: null as unknown },
}));

vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const hooks = {
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, vi.fn()],
    useRef: (value: unknown) => ({ current: value }),
    useEffect: () => undefined,
  };
  return { ...actual, ...hooks, default: { ...actual['default'], ...hooks } };
});
vi.mock('react-native', () => ({ Dimensions: { get: () => ({ width: 390 }) }, ScrollView: 'ScrollView', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: vi.fn(), setParams: vi.fn(), getParent: () => null }),
  useRoute: () => ({ params: mocks.params }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@swift/ui', () => ({
  color: {
    surface: { subtle: 'surface-subtle', base: 'surface-base' }, brand: { 50: 'brand-50', 600: 'brand-600' },
    soft: { warning: 'warning-soft' }, warning: 'warning', star: 'star', error: 'error',
  },
  elevation: { dock: {} },
  radius: { md: 8, xl: 24 },
  space: { xs: 4, sm: 4, md: 8, lg: 12, xl: 20, '2xl': 24, '3xl': 32 },
}));
vi.mock('../../../hooks/customer', () => ({
  useVendor: () => mocks.vendor,
  useAddToCart: () => ({ mutate: mocks.mutate, ...mocks.addState }),
  useItemSlots: () => ({ data: undefined, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: () => ({ isAuthenticated: true, promptLogin: vi.fn() }) }));
vi.mock('../../../stores/bookingStore', () => ({ useBookingStore: (select: (state: unknown) => unknown) => select({ setAppointment: vi.fn() }) }));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => null, HERO_PHOTO_WIDTH: 800 }));
vi.mock('../../../lib/money', () => ({ money: (amount: number) => `$${amount.toLocaleString('en-US')}` }));
vi.mock('../../../kit', () => Object.fromEntries([
  'Photo', 'Chip', 'CheckRow', 'CircleChip', 'ErrorState', 'IconChip', 'LoadingBlock', 'Money', 'LabeledInput', 'Segmented', 'TonePill',
  'PillButton', 'PopupCard', 'PopupTitle', 'QtyStepper', 'SectionHeader', 'T', 'Header', 'EmptyState',
].map((name) => [name, name])));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));
vi.mock('../../../kit/keyboard-avoider', () => ({ KeyboardAvoider: 'KeyboardAvoider' }));

import { MenuItemScreen } from './MenuItemScreen';
import { ItemChoices } from '../components/ItemChoices';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] The phone's item screen with a sized, half-and-half pizza: "From" until a size
// is chosen; the Add shows the server's price (size IS the price, a half at the store's percent); the choices go to
// the cart as the API reads them (`id`, `id:left`); an older-app refusal shows the server's own words.
// Synthetic store and menu only.
// ---------------------------------------------------------------------------

const opt = (id: string, name: string, additionalPrice: number, extra: Record<string, unknown> = {}) =>
  ({ id, name, additionalPrice, isAvailable: true, isDefault: false, sortOrder: 0, followUpGroupId: null, ...extra });
const PIZZA = {
  id: 'pizza-1', name: 'Garden pizza', basePrice: 1200, customerPrice: 1200, isAvailable: true, fulfillment: 'DELIVERY',
  optionGroups: [
    { id: 'size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 0, setsPrice: true, allowHalves: false, halfPricePercent: 100,
      options: [opt('personal', 'Personal', 1200), opt('large', 'Large', 3500, { sortOrder: 1 })] },
    { id: 'toppings', name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 3, sortOrder: 1, setsPrice: false, allowHalves: true, halfPricePercent: 50,
      options: [opt('pep', 'Pepperoni', 300), opt('mush', 'Mushroom', 175, { sortOrder: 1 })] },
  ],
};
const STORE = { name: 'Sample Pizza', vendorType: 'RESTAURANT', categories: [{ items: [PIZZA] }] };

function nodes(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out; }
  out.push(node);
  nodes(node.props?.children, out);
  return out;
}
const render = () => nodes(MenuItemScreen());
const addButton = (tree: any[]) => tree.find((n) => n.type === 'PillButton' && /cart|options|stock/.test(String(n.props.label)));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.vendor = { isLoading: false, isError: false, refetch: vi.fn(), data: STORE };
  mocks.params = { vendorId: 'store-1', itemId: 'pizza-1' };
  mocks.addState = { isPending: false, isError: false, error: null };
});

describe('[MENU-OPTIONS] the phone item screen', () => {
  it('opens on "From" the smallest size, and Add waits for a size', () => {
    const tree = render();
    expect(tree.some((n) => n.type === 'T' && n.props.children === 'From')).toBe(true);
    expect(tree.find((n) => n.type === 'Money')?.props.amount).toBe(1200);
    expect(addButton(tree).props).toMatchObject({ label: 'Choose required options', disabled: true });
    expect(tree.find((n) => n.type === ItemChoices)?.props.groups).toBe(PIZZA.optionGroups);
  });

  it('a large with pepperoni on the left half: $3,650 — and the cart is sent `pep:left`, a pick-one group as one choice', () => {
    mocks.params = { ...mocks.params, addDraft: { quantity: 2, selectedOptions: { size: 'large', toppings: ['pep:left'] }, dayOffset: 0, slot: null, visitMode: 'AT_BUSINESS' } };
    const tree = render();
    expect(tree.some((n) => n.type === 'T' && n.props.children === 'From')).toBe(false);
    expect(tree.find((n) => n.type === 'Money')?.props.amount).toBe(3650);
    const add = addButton(tree);
    expect(add.props).toMatchObject({ label: 'Add to cart · $7,300', disabled: false });
    add.props.onPress();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0]![0]).toEqual({
      vendorId: 'store-1', itemId: 'pizza-1', quantity: 2, selectedOptions: { size: 'large', toppings: ['pep:left'] },
    });
  });

  it('a kept choice the menu no longer allows (a half of a size) blocks the Add: the server’s validator decides', () => {
    mocks.params = { ...mocks.params, addDraft: { quantity: 1, selectedOptions: { size: 'large:left' }, dayOffset: 0, slot: null, visitMode: 'AT_BUSINESS' } };
    expect(addButton(render()).props).toMatchObject({ label: 'Choose required options', disabled: true });
  });

  it('an older-app refusal (409 APP_UPDATE_REQUIRED) shows the server’s own words', () => {
    const message = 'This item has choices this version of the Swift app cannot show (sizes, half-and-half or extra choices). Update the Swift app to order it.';
    mocks.addState = { isPending: false, isError: true, error: { response: { status: 409, data: { error: { code: 'APP_UPDATE_REQUIRED', message } } } } };
    expect(render().some((n) => n.type === 'T' && n.props.children === message)).toBe(true);
  });
});
