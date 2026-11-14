import { beforeEach, describe, expect, it, vi } from 'vitest';

// [MENU-BULK · parity audit C2, owner 14 Nov 2026] Tick several items on the Menu tab and mark them sold out, or back
// on, in one go: "Select" puts a tick on every row; a bar under the list counts the ticks and offers "Select all
// shown", "Clear", "Mark sold out" and "Make available"; the store is asked first (how many, what happens); the answer
// is counted on screen ("12 items marked sold out. 2 were already sold out."). One request (POST
// /vendor/items/availability/bulk). Staff may (as the one-item switch); never in a sample preview.
// The screen is called as a function (no RN renderer) and its tree inspected, as VendorMenuScreen.search.test.ts.

vi.hoisted(() => { (globalThis as { __DEV__?: boolean }).__DEV__ = false; });
const h = vi.hoisted(() => ({
  state: [] as unknown[],
  at: 0,
  menu: [] as unknown[],
  role: 'OWNER' as string,
  storeId: 'store-a' as string,
  preview: null as null | string,
  bulk: [] as Array<{ vars: any; options: any }>,
  bulkPending: false,
  refetch: () => undefined,
}));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = h.at++;
    if (!(slot in h.state)) h.state[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [h.state[slot], (next: unknown) => { h.state[slot] = typeof next === 'function' ? (next as (v: unknown) => unknown)(h.state[slot]) : next; }];
  },
  useEffect: () => undefined,
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
}));
vi.mock('react-native', () => ({ FlatList: 'FlatList', Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({
  color: { brand: {}, text: {}, surface: {}, soft: {}, border: {}, warning: 'warning', error: 'error', white: 'white', scrim: 'scrim' },
  radius: {}, space: {},
}));
vi.mock('../../../kit', () => ({
  Card: 'Card', Chip: 'Chip', EmptyState: 'EmptyState', ErrorState: 'ErrorState', IconChip: 'IconChip', LoadingBlock: 'LoadingBlock',
  PillButton: 'PillButton', PopupCard: 'PopupCard', PopupTitle: 'PopupTitle', Screen: 'Screen', T: 'T', TonePill: 'TonePill',
}));
vi.mock('../../../kit/switch', () => ({ Switch: 'Switch' }));
vi.mock('../shared', () => ({
  GUTTER: 0, InlineInput: 'InlineInput', SubHeader: 'SubHeader',
  catalogueMeta: () => ({ label: 'Menu', catPlaceholder: 'e.g. Mains' }), safeVendorRole: () => h.role,
  numericFact: (v: unknown) => (typeof v === 'number' ? v : null),
}));
vi.mock('../CatalogueSearchBar', () => ({ CatalogueSearchBar: 'CatalogueSearchBar' }));
// The debounce is its own hook (hooks/useDebouncedValue.test.ts); here a typed word applies at once.
vi.mock('../../../hooks/useDebouncedValue', () => ({ useDebouncedValue: (v: unknown) => v }));
vi.mock('../../../hooks/vendorops', () => {
  const mutation = () => ({ mutate: () => undefined, isPending: false });
  return {
    useVendorProfile: () => ({ owner: { myRole: h.role }, store: { id: h.storeId, vendorType: 'RESTAURANT' } }),
    useVendorMenu: () => ({ data: h.menu, isLoading: false, isError: false, refetch: h.refetch }),
    useCreateCategory: mutation, useUpdateCategory: mutation, useDeleteCategory: mutation,
    useDeleteItem: mutation, useSetItemAvailability: mutation, useUploadCategoryPhoto: mutation, useRemoveCategoryPhoto: mutation,
    useBulkAvailability: () => ({ mutate: (vars: unknown, options: unknown) => h.bulk.push({ vars, options }), isPending: h.bulkPending }),
  };
});
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false, onRefresh: async () => undefined }) }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (s: { previewType: null | string }) => unknown) => pick({ previewType: h.preview }) }));
vi.mock('../../../lib/images', () => ({ isKeptPhoto: () => false, storePhotoUrl: (key: string) => key }));

import { MenuItemRow, SelectableRow, VendorMenuScreen } from './VendorMenuScreen';

function all(node: any, match: (n: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) all(n, match, out); return out; }
  if (match(node)) out.push(node);
  for (const value of Object.values(node.props ?? {})) {
    if (typeof value === 'function') continue;
    all(value, match, out);
  }
  return out;
}
const ofType = (tree: any, type: unknown) => all(tree, (n) => n.type === type);
const textOf = (n: any) => [n.props.children].flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number').join('');
const texts = (tree: any) => ofType(tree, 'T').map(textOf);

const SECTIONS = 3;
const PER_SECTION = 60;
const menu = () => Array.from({ length: SECTIONS }, (_, s) => ({
  id: `c${s}`, name: `Section ${s}`, imageUrl: null,
  items: Array.from({ length: PER_SECTION }, (_, i) => ({
    id: `c${s}-i${i}`, name: `Dish ${s}.${i}`, sku: `SKU-${s}${i}`, basePrice: 500 + i, isAvailable: true, stockQuantity: null,
  })),
}));
const navigation = { navigate: () => undefined };
const draw = () => { h.at = 0; return VendorMenuScreen({ navigation }); };
const list = (tree: any) => { const found = ofType(tree, 'FlatList'); expect(found).toHaveLength(1); return found[0]; };
const rowsOf = (flat: any) => (flat.props.data as any[]).map((row, index) => flat.props.renderItem({ item: row, index }));
const bar = (tree: any) => { const found = ofType(tree, 'CatalogueSearchBar'); expect(found).toHaveLength(1); return found[0]; };

beforeEach(() => {
  h.state = [];
  h.menu = menu();
  h.role = 'OWNER';
  h.preview = null;
  h.storeId = 'store-a';
  h.bulk = [];
  h.bulkPending = false;
});

const pills = (tree: any) => ofType(tree, 'PillButton');
const pill = (tree: any, label: string) => pills(tree).find((b) => b.props.label === label);
const selectable = (tree: any) => rowsOf(list(tree)).filter((el) => el.type === SelectableRow);
const tick = (tree: any, id: string) => selectable(tree).find((el) => el.props.itemId === id)!.props.onToggle();
const popup = (tree: any) => ofType(tree, 'PopupCard').find((p) => p.props.visible);

describe('several items at once', () => {
  it('"Select" puts a tick on every row (the same row inside); Done takes them away', () => {
    let tree = draw();
    expect(selectable(tree)).toHaveLength(0);
    pill(tree, 'Select').props.onPress();
    tree = draw();
    const rows = selectable(tree);
    expect(rows).toHaveLength(SECTIONS * PER_SECTION);
    expect(rows[0].props).toMatchObject({ itemId: 'c0-i0', itemName: 'Dish 0.0', selected: false });
    expect(ofType(rows[0], MenuItemRow)[0].props.item.id).toBe('c0-i0');
    pill(tree, 'Done').props.onPress();
    expect(selectable(draw())).toHaveLength(0);
  });

  it('the bar counts the ticks; nothing ticked, nothing to send', () => {
    let tree = draw();
    pill(tree, 'Select').props.onPress();
    tree = draw();
    expect(texts(tree)).toContain('0 selected');
    expect(pill(tree, 'Mark sold out').props.disabled).toBe(true);
    expect(pill(tree, 'Make available').props.disabled).toBe(true);
    tick(tree, 'c0-i1');
    tree = draw();
    tick(tree, 'c2-i5');
    tree = draw();
    expect(texts(tree)).toContain('2 selected');
    expect(selectable(tree).find((el) => el.props.itemId === 'c0-i1').props.selected).toBe(true);
    expect(pill(tree, 'Mark sold out').props.disabled).toBe(false);
    tick(tree, 'c0-i1');
    expect(texts(draw())).toContain('1 selected');
  });

  it('[REVIEW-2520-A S4-4] ticks a search now hides are still counted, and said to be off screen', () => {
    pill(draw(), 'Select').props.onPress();
    tick(draw(), 'c0-i1');
    tick(draw(), 'c2-i5');
    bar(draw()).props.onChangeText('dish 2.5');
    expect(texts(draw())).toContain('2 selected · 1 not shown');
  });

  it('"Select all shown" ticks what the search shows; "Clear" unticks all', () => {
    let tree = draw();
    pill(tree, 'Select').props.onPress();
    bar(draw()).props.onChangeText('dish 1.1');
    tree = draw();
    pill(tree, 'Select all shown').props.onPress();
    tree = draw();
    expect(texts(tree)).toContain('11 selected');
    pill(tree, 'Clear').props.onPress();
    expect(texts(draw())).toContain('0 selected');
  });

  it('Mark sold out asks first (how many, what happens); yes sends ONE request with the ticked items', () => {
    let tree = draw();
    pill(tree, 'Select').props.onPress();
    tick(draw(), 'c0-i1');
    tick(draw(), 'c1-i2');
    tree = draw();
    pill(tree, 'Mark sold out').props.onPress();
    tree = draw();
    const ask = popup(tree);
    expect(ofType(ask, 'PopupTitle').map(textOf)).toEqual(['Mark 2 items sold out?']);
    expect(h.bulk).toHaveLength(0);
    pill(ask, 'Yes, mark sold out').props.onPress();
    expect(h.bulk).toHaveLength(1);
    expect([...h.bulk[0]!.vars.itemIds].sort()).toEqual(['c0-i1', 'c1-i2']);
    expect(h.bulk[0]!.vars.isAvailable).toBe(false);
  });

  it('the answer is counted on screen, the ticks are cleared and the rows go back to normal', () => {
    let tree = draw();
    pill(tree, 'Select').props.onPress();
    tick(draw(), 'c0-i1');
    tick(draw(), 'c0-i2');
    tick(draw(), 'c0-i3');
    pill(draw(), 'Mark sold out').props.onPress();
    pill(popup(draw()), 'Yes, mark sold out').props.onPress();
    h.bulk[0]!.options.onSuccess({ isAvailable: false, changedIds: ['c0-i1', 'c0-i2'], unchangedIds: ['c0-i3'], refused: [] });
    tree = draw();
    expect(texts(tree)).toContain('2 items marked sold out. 1 was already sold out.');
    expect(selectable(tree)).toHaveLength(0);
    expect(popup(tree)).toBeUndefined();
    pill(tree, 'Select').props.onPress();
    expect(texts(draw()), 'choosing again starts from no ticks').toContain('0 selected');
  });

  it('Make available: its own ask; an item Swift does not allow is named in the answer', () => {
    pill(draw(), 'Select').props.onPress();
    tick(draw(), 'c1-i0');
    pill(draw(), 'Make available').props.onPress();
    const ask = popup(draw());
    expect(ofType(ask, 'PopupTitle').map(textOf)).toEqual(['Make 1 item available?']);
    pill(ask, 'Yes, make available').props.onPress();
    expect(h.bulk[0]!.vars).toMatchObject({ itemIds: ['c1-i0'], isAvailable: true });
    h.bulk[0]!.options.onSuccess({ isAvailable: true, changedIds: [], unchangedIds: [], refused: [{ id: 'c1-i0', name: 'Dish 1.0', message: 'x' }] });
    expect(texts(draw())).toContain('0 items made available. Swift does not allow 1, so it stays off: Dish 1.0.');
  });

  it('Cancel on the ask sends nothing and keeps the ticks', () => {
    pill(draw(), 'Select').props.onPress();
    tick(draw(), 'c1-i0');
    pill(draw(), 'Mark sold out').props.onPress();
    pill(popup(draw()), 'Cancel').props.onPress();
    const tree = draw();
    expect(h.bulk).toHaveLength(0);
    expect(popup(tree)).toBeUndefined();
    expect(texts(tree)).toContain('1 selected');
  });

  it('a refusal says why and keeps the ticks to try again', () => {
    pill(draw(), 'Select').props.onPress();
    tick(draw(), 'c1-i0');
    pill(draw(), 'Mark sold out').props.onPress();
    pill(popup(draw()), 'Yes, mark sold out').props.onPress();
    h.bulk[0]!.options.onError({ response: { data: { error: { message: 'Item with id in this batch not found' } } } });
    let tree = draw();
    expect(texts(tree)).toContain('Item with id in this batch not found');
    expect(texts(tree)).toContain('1 selected');
    h.bulk[0]!.options.onError(new Error('Network Error'));
    tree = draw();
    expect(texts(tree)).toContain('The items didn’t change. Check your connection and try again.');
  });

  it('switching store drops the ticks, the ask and select mode (they belong to the other store)', () => {
    pill(draw(), 'Select').props.onPress();
    tick(draw(), 'c1-i0');
    pill(draw(), 'Mark sold out').props.onPress();
    expect(popup(draw())).toBeTruthy();
    h.storeId = 'store-b';
    draw();
    const tree = draw();
    expect(popup(tree)).toBeUndefined();
    expect(selectable(tree)).toHaveLength(0);
    pill(tree, 'Select').props.onPress();
    expect(texts(draw())).toContain('0 selected');
  });

  it('floor staff may (as the one-item switch); a sample preview may not', () => {
    h.role = 'STAFF';
    expect(pill(draw(), 'Select')).toBeTruthy();
    h.state = [];
    h.role = 'OWNER';
    h.preview = 'RESTAURANT';
    expect(pill(draw(), 'Select')).toBeUndefined();
  });

  it('the bar is under the list, not a row of it (it stays on screen while the list scrolls)', () => {
    pill(draw(), 'Select').props.onPress();
    const tree = draw();
    expect(ofType(list(tree), 'PillButton').filter((b) => b.props.label === 'Mark sold out')).toHaveLength(0);
    expect(pill(tree, 'Mark sold out')).toBeTruthy();
  });
});
