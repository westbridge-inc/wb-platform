import { beforeEach, describe, expect, it, vi } from 'vitest';

// [MENU-SEARCH · owner 14 Nov 2026: "staff need to find an item to edit or take off without scrolling" — Parampara
// has 328 items; KFC and Pizza Hut run the app on tablets] The store's Menu / Products / Services tab (one screen for
// every store type) has the website's "Search name or SKU" box (dashboard/inventory) at the top, outside the list so
// it stays put while the list scrolls. It filters the menu the tab already holds (GET /vendor/categories sends every
// item: nothing to page), keeps each match under its own section heading, says how many it found, and says so when
// none match. Every row is the same MenuItemRow, so switching off, editing and deleting work the same from a search.
// As in VendorMenuScreen.speed.test.ts the screen is called as a function (no RN renderer) and its tree inspected.

vi.hoisted(() => { (globalThis as { __DEV__?: boolean }).__DEV__ = false; });
const h = vi.hoisted(() => ({
  state: [] as unknown[],
  at: 0,
  menu: [] as unknown[],
  role: 'OWNER' as string,
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
    useVendorProfile: () => ({ owner: { myRole: h.role }, store: { vendorType: 'RESTAURANT' } }),
    useVendorMenu: () => ({ data: h.menu, isLoading: false, isError: false, refetch: h.refetch }),
    useCreateCategory: mutation, useUpdateCategory: mutation, useDeleteCategory: mutation,
    useDeleteItem: mutation, useSetItemAvailability: mutation, useUploadCategoryPhoto: mutation, useRemoveCategoryPhoto: mutation,
    useBulkAvailability: mutation,
  };
});
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false, onRefresh: async () => undefined }) }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (s: { previewType: null }) => unknown) => pick({ previewType: null }) }));
vi.mock('../../../lib/images', () => ({ isKeptPhoto: () => false, storePhotoUrl: (key: string) => key }));

import { CategoryHeader, MenuItemRow, VendorMenuScreen } from './VendorMenuScreen';

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
const drawnRows = (tree: any) => rowsOf(list(tree)).flatMap((el) => all(el, (n) => n.type === MenuItemRow || n.type === CategoryHeader));
const shownIds = (tree: any) => drawnRows(tree).map((el) => (el.type === CategoryHeader ? `#${el.props.cat.id}` : el.props.item.id));
const bar = (tree: any) => { const found = ofType(tree, 'CatalogueSearchBar'); expect(found).toHaveLength(1); return found[0]; };
const type = (words: string) => { bar(draw()).props.onChangeText(words); return draw(); };

beforeEach(() => {
  h.state = [];
  h.menu = menu();
  h.role = 'OWNER';
});

describe('the Menu tab has the website\'s "Search name or SKU" box', () => {
  it('sits above the list, outside it, so it stays on screen while the list scrolls', () => {
    const tree = draw();
    const flat = list(tree);
    expect(bar(tree).props.placeholder).toBe('Search name or SKU');
    expect(ofType(flat, 'CatalogueSearchBar'), 'the box is not a row of the list').toHaveLength(0);
    // A row tapped while the keyboard is up acts at once (one tap, not one to close the keyboard first).
    expect(flat.props.keyboardShouldPersistTaps).toBe('handled');
    expect(flat.props.keyboardDismissMode).toBe('on-drag');
  });

  it('an empty menu has nothing to search: no box', () => {
    h.menu = [];
    expect(ofType(draw(), 'CatalogueSearchBar')).toHaveLength(0);
  });

  it('says how many items are shown, before and while searching', () => {
    expect(texts(draw())).toContain('180 items');
    expect(texts(type('dish 1.1'))).toContain('11 items');
  });

  it('keeps the matches under their own section heading, in menu order; sections with no match drop', () => {
    const tree = type('DISH 1.1');
    expect(shownIds(tree)).toEqual(['#c1', 'c1-i1', ...Array.from({ length: 10 }, (_, i) => `c1-i${10 + i}`)]);
    const heading = drawnRows(tree).find((el) => el.type === CategoryHeader)!;
    // The heading is the whole section (its count and its "Delete section + N items" are never the matches only).
    expect(heading.props.cat.items).toHaveLength(PER_SECTION);
  });

  it('finds an item by its SKU', () => {
    expect(shownIds(type('sku-247'))).toEqual(['#c2', 'c2-i47']);
  });

  it('finds an item by a choice in its options (a size, a topping)', () => {
    (h.menu[0] as any).items[3].optionGroups = [{ name: 'Size', options: [{ name: 'Family bucket' }] }];
    expect(shownIds(type('bucket'))).toEqual(['#c0', 'c0-i3']);
  });

  it('every row found is the same row, with the same tools: switch off, edit and delete as before', () => {
    const tree = type('dish 2.5');
    const row = drawnRows(tree).find((el) => el.type === MenuItemRow)!;
    expect(row.props).toMatchObject({ canEdit: true, navigation, categories: menu().map((c) => ({ id: c.id, name: c.name })) });
    expect(row.props.item).toBe((h.menu[2] as any).items[5]);
  });

  it('floor staff search too, and still only switch items on and off', () => {
    h.role = 'STAFF';
    const tree = type('dish 0.7');
    const rows = drawnRows(tree);
    expect(rows.filter((el) => el.type === MenuItemRow).length).toBeGreaterThan(0);
    expect(rows.every((el) => el.props.canEdit === false)).toBe(true);
  });

  it('while searching, the results lead (the manager tools above the list step aside); clearing brings them back', () => {
    const labels = (tree: any) => all(list(tree).props.ListHeaderComponent, (n) => n.type === 'PillButton').map((n) => n.props.label);
    expect(labels(draw())).toContain('Add item');
    const tree = type('dish');
    expect(labels(tree)).not.toContain('Add item');
    bar(tree).props.onClear();
    expect(labels(draw())).toContain('Add item');
    expect(shownIds(draw())).toHaveLength(SECTIONS * (PER_SECTION + 1));
  });

  it('the x clears the search and shows the whole menu again', () => {
    const tree = type('dish 1.1');
    expect(bar(tree).props.value).toBe('dish 1.1');
    bar(tree).props.onClear();
    const again = draw();
    expect(bar(again).props.value).toBe('');
    expect(shownIds(again)).toHaveLength(SECTIONS * (PER_SECTION + 1));
  });

  it('no match: a plain answer naming what was typed, and one tap back to every item', () => {
    const tree = type('pizza');
    const flat = list(tree);
    expect(flat.props.data).toHaveLength(0);
    const empty = flat.props.ListEmptyComponent;
    expect(empty.type).toBe('EmptyState');
    expect(empty.props.title).toBe('No items match “pizza”.');
    empty.props.onAction();
    expect(shownIds(draw())).toHaveLength(SECTIONS * (PER_SECTION + 1));
  });

  it('a section chip and a search work together', () => {
    let tree = type('dish');
    ofType(list(tree).props.ListHeaderComponent, 'Chip').find((c) => String(c.props.label).startsWith('Section 2')).props.onPress();
    tree = draw();
    const ids = shownIds(tree);
    expect(ids[0]).toBe('#c2');
    expect(ids.slice(1).every((id) => id.startsWith('c2-'))).toBe(true);
    expect(texts(tree)).toContain('60 items');
  });
});

// [MENU-FILTERS · parity audit C1] The filter buttons next to the search, as on the website: Sold out, Low stock (a
// store that counts stock only), No photo. Each says how many it holds; one at a time; tapped again, it is off.
describe('the filter buttons', () => {
  const button = (tree: any, word: string) => ofType(tree, 'Chip').find((c) => String(c.props.label).startsWith(`${word} · `));

  it('a restaurant (no stock counted) gets Sold out and No photo, each with its count', () => {
    (h.menu[0] as any).items[1].isAvailable = false;
    (h.menu[2] as any).items[9].isAvailable = false;
    (h.menu[1] as any).items[0].imageUrl = 'stores/v1/a.jpg';
    const tree = draw();
    expect(button(tree, 'Low stock')).toBeUndefined();
    expect(button(tree, 'Sold out')!.props.label).toBe('Sold out · 2');
    expect(button(tree, 'No photo')!.props.label).toBe('No photo · 179');
    expect(bar(tree), 'the buttons sit with the box, above the list').toBeTruthy();
    expect(ofType(list(tree), 'Chip').filter((c) => String(c.props.label).startsWith('Sold out'))).toHaveLength(0);
  });

  it('Sold out shows only the switched-off items, under their sections; tapped again, every item is back', () => {
    (h.menu[0] as any).items[1].isAvailable = false;
    (h.menu[2] as any).items[9].isAvailable = false;
    let tree = draw();
    expect(button(tree, 'Sold out')!.props.selected).toBe(false);
    button(tree, 'Sold out')!.props.onPress();
    tree = draw();
    expect(button(tree, 'Sold out')!.props.selected).toBe(true);
    expect(shownIds(tree)).toEqual(['#c0', 'c0-i1', '#c2', 'c2-i9']);
    expect(texts(tree)).toContain('2 items');
    button(tree, 'Sold out')!.props.onPress();
    expect(shownIds(draw())).toHaveLength(SECTIONS * (PER_SECTION + 1));
  });

  it('No photo shows the items customers see no photo for', () => {
    for (const s of h.menu as any[]) for (const it of s.items) it.imageUrl = 'stores/v1/x.jpg';
    (h.menu[1] as any).items[4].imageUrl = null;
    let tree = draw();
    button(tree, 'No photo')!.props.onPress();
    tree = draw();
    expect(shownIds(tree)).toEqual(['#c1', 'c1-i4']);
  });

  it('one button at a time: choosing another moves the choice', () => {
    (h.menu[0] as any).items[1].isAvailable = false;
    let tree = draw();
    button(tree, 'Sold out')!.props.onPress();
    tree = draw();
    button(tree, 'No photo')!.props.onPress();
    tree = draw();
    expect(button(tree, 'Sold out')!.props.selected).toBe(false);
    expect(button(tree, 'No photo')!.props.selected).toBe(true);
  });

  it('no item under the button: the answer says which button is on, and one tap shows every item', () => {
    let tree = draw();
    button(tree, 'Sold out')!.props.onPress();
    tree = draw();
    const empty = list(tree).props.ListEmptyComponent;
    expect(empty.props.title).toBe('No items match.');
    expect(empty.props.body).toBe('Showing sold out items only.');
    empty.props.onAction();
    expect(shownIds(draw())).toHaveLength(SECTIONS * (PER_SECTION + 1));
  });

  it('Low stock (a store that counts stock): counted items at or under their alert level, with a search too', () => {
    const items = (h.menu[1] as any).items;
    items[0].stockQuantity = 2;
    items[1].stockQuantity = 50;
    items[2].stockQuantity = 8; items[2].lowStockThreshold = 10;
    let tree = draw();
    expect(button(tree, 'Low stock')!.props.label).toBe('Low stock · 2');
    button(tree, 'Low stock')!.props.onPress();
    tree = draw();
    expect(shownIds(tree)).toEqual(['#c1', 'c1-i0', 'c1-i2']);
    expect(texts(tree)).toContain('2 items');
    bar(tree).props.onChangeText('1.2');
    expect(shownIds(draw())).toEqual(['#c1', 'c1-i2']);
  });
});
