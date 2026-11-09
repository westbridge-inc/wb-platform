import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refetchSlots: vi.fn(),
  slots: {} as Record<string, any>,
  effects: [] as Array<() => void>,
  useStateCall: 0,
  selectedSlot: null as string | null,
  setSelectedSlot: vi.fn(),
  vendor: {} as Record<string, any>,
  goBack: vi.fn(),
}));

vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const hooks = {
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) => {
      const call = mocks.useStateCall++;
      const value = call === 3
        ? mocks.selectedSlot
        : typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [value, call === 3 ? mocks.setSelectedSlot : vi.fn()];
    },
    useRef: (value: unknown) => ({ current: value }),
    useEffect: (effect: () => void) => mocks.effects.push(effect),
  };
  return { ...actual, ...hooks, default: { ...actual['default'], ...hooks } };
});
vi.mock('react-native', () => ({
  Dimensions: { get: () => ({ width: 390 }) },
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mocks.goBack }),
  useRoute: () => ({ params: { vendorId: 'vendor-1', itemId: 'item-1' } }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@swift/ui', () => ({
  color: {
    surface: { subtle: 'surface-subtle', base: 'surface-base' }, brand: { 50: 'brand-50', 600: 'brand-600' },
    soft: { warning: 'warning-soft' }, warning: 'warning', star: 'star', error: 'error',
  },
  elevation: { dock: {} },
  radius: { md: 8, xl: 24 },
  space: { sm: 4, md: 8, lg: 12, '2xl': 24 },
}));
vi.mock('../../../hooks/customer', () => ({
  useVendor: () => mocks.vendor,
  useAddToCart: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useItemSlots: () => ({ ...mocks.slots, refetch: mocks.refetchSlots }),
}));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: () => ({ isAuthenticated: true, promptLogin: vi.fn() }),
}));
vi.mock('../../../stores/bookingStore', () => ({
  useBookingStore: (select: (state: unknown) => unknown) => select({ setAppointment: vi.fn() }),
}));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => null, HERO_PHOTO_WIDTH: 1080 }));
vi.mock('../../../lib/money', () => ({ money: (amount: number) => `$${amount}` }));
vi.mock('../../../kit', () => Object.fromEntries([
  'Photo', 'Chip', 'CircleChip', 'ErrorState', 'IconChip', 'LoadingBlock', 'Money',
  'PillButton', 'PopupCard', 'PopupTitle', 'QtyStepper', 'SectionHeader', 'T', 'Header', 'EmptyState', 'TonePill', 'LabeledInput',
].map((name) => [name, name])));
vi.mock('../components/ItemDescription', () => ({ ItemDescription: 'ItemDescription' }));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));

import { MenuItemScreen } from './MenuItemScreen';

// ---------------------------------------------------------------------------
// [STORE-WORDS · owner 9 Nov 2026] A clothing shop ("Westbridge Inc." selling a "Boys vest") showed
// "e.g. no onions, extra pepper" in the note box and a "30 min prep" chip. The item page now speaks
// the store's kind: a shop gets shop words, a restaurant keeps its own words exactly.
// ---------------------------------------------------------------------------

function nodes(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out; }
  out.push(node);
  nodes(node.props?.children, out);
  return out;
}
const ITEM = { id: 'item-1', name: 'Boys vest', basePrice: 1_500, optionGroups: [], isAvailable: true };
const store = (vendorType: string | undefined, extra: Record<string, unknown> = {}) => ({
  name: 'Westbridge Inc.', city: 'Georgetown', vendorType, estimatedPrepTime: 30, categories: [{ items: [ITEM] }], ...extra,
});
const render = (data: unknown) => {
  mocks.useStateCall = 0;
  mocks.vendor = { isLoading: false, isError: false, refetch: vi.fn(), data };
  return nodes(MenuItemScreen());
};
const ofType = (tree: any[], type: string) => tree.filter((n) => n.type === type);
const text = (n: any): string => (Array.isArray(n.props?.children) ? n.props.children.join('') : String(n.props?.children ?? ''));
const placeholder = (tree: any[]) => ofType(tree, 'LabeledInput').find((n) => n.props.testID === 'menu-item-note')?.props.placeholder;
const labels = (tree: any[]) => ofType(tree, 'T').map(text);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects = [];
  mocks.selectedSlot = null;
  mocks.slots = { data: undefined, isPending: false, isLoading: false, isFetching: false, isError: false };
});

describe('[STORE-WORDS] the item page speaks the store\'s kind', () => {
  it('a shop: a shop\'s note hint and "Ready in about 30 min", never a kitchen\'s words', () => {
    const tree = render(store('STORE'));
    expect(placeholder(tree)).toBe('e.g. size, colour, gift wrap');
    expect(labels(tree)).toContain('Ready in about 30 min');
    const all = JSON.stringify(labels(tree)) + String(placeholder(tree));
    expect(all).not.toMatch(/onion|pepper|\bprep\b/);
  });

  it('a supermarket and a service business get their own note hints', () => {
    expect(placeholder(render(store('SUPERMARKET')))).toBe('e.g. ripe ones, no substitutes');
    expect(placeholder(render(store('SERVICE')))).toBe('e.g. what you need, and anything that helps');
  });

  it('a restaurant is unchanged: "e.g. no onions, extra pepper" and "30 min prep"', () => {
    const tree = render(store('RESTAURANT'));
    expect(placeholder(tree)).toBe('e.g. no onions, extra pepper');
    expect(labels(tree)).toContain('30 min prep');
  });

  it('a kind this build does not know: neutral words, never a kitchen\'s', () => {
    const tree = render(store(undefined));
    expect(placeholder(tree)).toBe('Anything the store should know');
    expect(labels(tree)).toContain('Ready in about 30 min');
  });

  it('a shop with no time sent: no time chip at all, never an invented "30"', () => {
    const tree = render(store('STORE', { estimatedPrepTime: null }));
    expect(labels(tree).filter((l) => /\bmin\b/.test(l))).toEqual([]);
  });

  it('a shop\'s item taken off sale: "no longer for sale", not "on the menu"', () => {
    const tree = render(store('STORE', { categories: [{ items: [] }] }));
    const [gone] = ofType(tree, 'EmptyState');
    expect(gone?.props).toMatchObject({
      title: 'This item is no longer for sale.',
      body: 'The store took it off. Pick something else from the store.',
      actionLabel: 'Go back',
    });
  });
});
