import { beforeEach, describe, expect, it, vi } from 'vitest';

// [MENU-ROW-TOOLS · parity audit A5 + A6, owner 14 Nov 2026] As on the website's menu page: a manager taps an item's
// price on the list, types the new one and saves (no trip through the item editor), and anyone at the store adjusts a
// counted item's stock on its row with a reason (received, damaged, …). The same calls as before: the item save
// (PUT /vendor/items/:id, the price field the editor sends: before VAT where Swift adds VAT) and the reasoned stock
// movement (POST /vendor/items/:id/adjust with a key per entry, so a retry never moves stock twice).
// The row and the tools are called as functions; a small stand-in for React keeps their state.

vi.hoisted(() => { (globalThis as { __DEV__?: boolean }).__DEV__ = false; });
const h = vi.hoisted(() => ({
  state: [] as unknown[],
  at: 0,
  preview: null as null | string,
  keys: 0,
  saves: [] as Array<{ vars: any; options: any }>,
  adjusts: [] as Array<{ vars: any; options: any }>,
  savePending: false,
}));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = h.at++;
    if (!(slot in h.state)) h.state[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [h.state[slot], (next: unknown) => { h.state[slot] = typeof next === 'function' ? (next as (v: unknown) => unknown)(h.state[slot]) : next; }];
  },
  useEffect: () => undefined,
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View', FlatList: 'FlatList' }));
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
  catalogueMeta: () => ({}), safeVendorRole: () => 'OWNER', numericFact: (v: unknown) => (typeof v === 'number' ? v : null),
}));
vi.mock('../CatalogueSearchBar', () => ({ CatalogueSearchBar: 'CatalogueSearchBar' }));
vi.mock('../../../hooks/vendorops', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useVendorProfile: () => ({}), useVendorMenu: () => ({}),
    useCreateCategory: mutation, useUpdateCategory: mutation, useDeleteCategory: mutation,
    useDeleteItem: mutation, useSetItemAvailability: mutation, useUploadCategoryPhoto: mutation, useRemoveCategoryPhoto: mutation,
    useSoldInStoreSender: () => ({ tap: vi.fn(), undo: vi.fn(), retry: vi.fn() }),
    useSaveItem: () => ({ mutate: (vars: unknown, options: unknown) => h.saves.push({ vars, options }), isPending: h.savePending }),
    useAdjustStock: () => ({ mutate: (vars: unknown, options: unknown) => h.adjusts.push({ vars, options }), isPending: false }),
    newStockKey: () => `stock-key-${++h.keys}`,
  };
});
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (s: { previewType: null | string }) => unknown) => pick({ previewType: h.preview }) }));
vi.mock('../../../lib/images', () => ({ isKeptPhoto: () => false, storePhotoUrl: () => null }));

import { MenuItemRow } from './VendorMenuScreen';
import { RowPriceEdit, RowStockAdjust } from '../MenuRowTools';

function all(node: any, match: (n: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) all(n, match, out); return out; }
  if (match(node)) out.push(node);
  for (const child of [node.props?.children].flat(Infinity)) {
    if (typeof child === 'function') continue;
    all(child, match, out);
  }
  return out;
}
const ofType = (tree: any, type: unknown) => all(tree, (n) => n.type === type);
const textOf = (n: any) => [n.props.children].flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number').join('');
const texts = (tree: any) => ofType(tree, 'T').map(textOf);
const pill = (tree: any, label: string) => ofType(tree, 'PillButton').find((b) => b.props.label === label);
const pressable = (tree: any, label: string) => ofType(tree, 'Pressable').find((p) => p.props.accessibilityLabel === label);

const navigation = { navigate: vi.fn() };
const curry = (over: Record<string, unknown> = {}) => ({ id: 'i1', name: 'Chicken Curry', basePrice: 1200, isAvailable: true, stockQuantity: null, optionGroups: [], ...over });
const row = (item: any, canEdit = true) => { h.at = 0; return MenuItemRow({ item, navigation, categories: [], canEdit }); };
const priceTool = (item: any) => { h.at = 0; return RowPriceEdit({ item, onDone: done }); };
const stockTool = (item: any) => { h.at = 0; return RowStockAdjust({ item }); };
const done = vi.fn();

beforeEach(() => {
  h.state = []; h.preview = null; h.keys = 0; h.saves = []; h.adjusts = []; h.savePending = false;
  done.mockClear();
});

describe('A5: a manager changes the price from the list', () => {
  it('the price is a button; tapped, the price box opens on that row', () => {
    let tree = row(curry());
    const price = pressable(tree, 'Change price: Chicken Curry');
    expect(price, 'the price is tappable').toBeTruthy();
    expect(price.props.accessibilityRole).toBe('button');
    expect(ofType(tree, RowPriceEdit)).toHaveLength(0);
    price.props.onPress();
    tree = row(curry());
    const box = ofType(tree, RowPriceEdit);
    expect(box).toHaveLength(1);
    expect(box[0].props.item.id).toBe('i1');
    box[0].props.onDone();
    expect(ofType(row(curry()), RowPriceEdit)).toHaveLength(0);
  });

  it('floor staff see the price as text (editing stays with a manager or owner)', () => {
    const tree = row(curry(), false);
    expect(pressable(tree, 'Change price: Chicken Curry')).toBeUndefined();
    expect(texts(tree).some((t) => t.includes('1,200') || t.includes('1200'))).toBe(true);
  });

  it('not in a sample preview, and not on an item whose size sets its price (the editor\'s "From" price)', () => {
    h.preview = 'RESTAURANT';
    expect(pressable(row(curry()), 'Change price: Chicken Curry')).toBeUndefined();
    h.preview = null;
    const sized = curry({ optionGroups: [{ setsPrice: true, options: [{ additionalPrice: 1000 }, { additionalPrice: 1500 }] }] });
    expect(pressable(row(sized), 'Change price: Chicken Curry')).toBeUndefined();
  });

  it('the box starts at the price, saves the new one as the item save does, and closes on the answer', () => {
    let tree = priceTool(curry());
    expect(ofType(tree, 'InlineInput')[0].props.value).toBe('1200');
    // [REVIEW #2516 S3-1] Whole Guyana dollars: a number pad, "0" as the hint, and the rule said in words.
    expect(ofType(tree, 'InlineInput')[0].props.keyboardType).toBe('number-pad');
    expect(ofType(tree, 'InlineInput')[0].props.placeholder).toBe('0');
    expect(ofType(tree, 'InlineInput')[0].props.accessibilityLabel).toBe('Price: Chicken Curry');
    expect(texts(tree)).toContain('Prices are whole Guyana dollars.');
    ofType(tree, 'InlineInput')[0].props.onChangeText('1350');
    tree = priceTool(curry());
    pill(tree, 'Save price').props.onPress();
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]!.vars).toEqual({ id: 'i1', data: { basePrice: 1350 } });
    expect(done).not.toHaveBeenCalled();
    h.saves[0]!.options.onSuccess();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('an item Swift adds VAT to: the box is the price before VAT, saved as such', () => {
    const vat = curry({ basePrice: 1140, vatListedPrice: 1000 });
    let tree = priceTool(vat);
    expect(texts(tree)).toContain('Price before VAT');
    expect(ofType(tree, 'InlineInput')[0].props.accessibilityLabel).toBe('Price before VAT: Chicken Curry');
    expect(ofType(tree, 'InlineInput')[0].props.value).toBe('1000');
    ofType(tree, 'InlineInput')[0].props.onChangeText('1100');
    tree = priceTool(vat);
    pill(tree, 'Save price').props.onPress();
    expect(h.saves[0]!.vars).toEqual({ id: 'i1', data: { vatListedPrice: 1100 } });
  });

  it('[REVIEW #2516 S3-1] cents, more than 10,000,000, an empty or non-number price cannot be saved', () => {
    for (const typed of ['', '1250.50', '12.5', '10000001', '-5', 'abc']) {
      h.state = [];
      priceTool(curry());
      ofType(priceTool(curry()), 'InlineInput')[0].props.onChangeText(typed);
      const tree = priceTool(curry());
      expect(pill(tree, 'Save price').props.disabled, typed).toBe(true);
      pill(tree, 'Save price').props.onPress();
    }
    expect(h.saves).toHaveLength(0);
  });

  it('[REVIEW #2516 S4-2] 0 and 10,000,000 are prices, as in the item editor; "1,500" is 1500', () => {
    for (const [typed, sent] of [['0', 0], ['10000000', 10_000_000], ['1,500', 1500]] as const) {
      h.state = []; h.saves = [];
      priceTool(curry());
      ofType(priceTool(curry()), 'InlineInput')[0].props.onChangeText(typed);
      const tree = priceTool(curry());
      expect(pill(tree, 'Save price').props.disabled, typed).toBe(false);
      pill(tree, 'Save price').props.onPress();
      expect(h.saves[0]!.vars.data, typed).toEqual({ basePrice: sent });
    }
  });

  it('a refusal says why, in the server\'s words, and the box stays open', () => {
    let tree = priceTool(curry());
    ofType(tree, 'InlineInput')[0].props.onChangeText('900');
    tree = priceTool(curry());
    pill(tree, 'Save price').props.onPress();
    h.saves[0]!.options.onError({ response: { data: { error: { message: 'Prices must be under $1,000,000.' } } } });
    tree = priceTool(curry());
    expect(texts(tree)).toContain('Prices must be under $1,000,000.');
    expect(done).not.toHaveBeenCalled();
    h.saves[0]!.options.onError(new Error('Network Error'));
    expect(texts(priceTool(curry()))).toContain('The price didn’t save. Check your connection and try again.');
  });

  it('Cancel closes the box without saving', () => {
    pill(priceTool(curry()), 'Cancel').props.onPress();
    expect(done).toHaveBeenCalledTimes(1);
    expect(h.saves).toHaveLength(0);
  });
});

// [REVIEW #2514 S4-3] The row's "N LEFT" pill follows the one Low stock rule (lib/catalogueSearch isLowStockItem), so every
// item the "Low stock" button shows carries a pill, a switched-off one too; an item with no alert level never does.
describe('the row\'s low stock pill is the Low stock button\'s rule', () => {
  const pills = (tree: any) => ofType(tree, 'TonePill').map((p) => p.props.label);
  it('at or under its own alert level: "N LEFT"; at 0: "0 LEFT"; no alert level: none', () => {
    expect(pills(row(curry({ stockQuantity: 3, lowStockThreshold: 5 })))).toContain('3 LEFT');
    expect(pills(row(curry({ stockQuantity: 0, lowStockThreshold: null })))).toContain('0 LEFT');
    expect(pills(row(curry({ stockQuantity: 3, lowStockThreshold: null }))).filter((l) => /LEFT/.test(l))).toEqual([]);
    expect(pills(row(curry({ stockQuantity: 6, lowStockThreshold: 5 }))).filter((l) => /LEFT/.test(l))).toEqual([]);
  });
  it('a switched-off item that is low still shows how many are left', () => {
    const labels = pills(row(curry({ isAvailable: false, stockQuantity: 2, lowStockThreshold: 5 })));
    expect(labels).toContain('SOLD OUT');
    expect(labels).toContain('2 LEFT');
  });
});

describe('A6: stock adjusted on the row, with a reason', () => {
  const rice = (over: Record<string, unknown> = {}) => curry({ id: 'r1', name: 'Rice 5 lb', stockQuantity: 12, lowStockThreshold: 3, ...over });

  it('a counted item\'s row has the adjuster, for staff too (any member may move stock, as the website)', () => {
    expect(ofType(row(rice()), RowStockAdjust)).toHaveLength(1);
    expect(ofType(row(rice(), false), RowStockAdjust)).toHaveLength(1);
    expect(ofType(row(curry()), RowStockAdjust), 'an item whose stock is not counted').toHaveLength(0);
    h.preview = 'SUPERMARKET';
    expect(ofType(row(rice()), RowStockAdjust), 'not in a sample preview').toHaveLength(0);
  });

  it('closed, it is one "Adjust stock" button; open, an amount, the website\'s reasons, Apply and Cancel', () => {
    let tree = stockTool(rice());
    const open = pressable(tree, 'Adjust stock: Rice 5 lb');
    expect(open.props.accessibilityRole).toBe('button');
    open.props.onPress();
    tree = stockTool(rice());
    expect(ofType(tree, 'InlineInput')[0].props.accessibilityLabel, '[REVIEW #2516 S4-5]').toBe('Adjust stock amount: Rice 5 lb');
    expect(ofType(tree, 'Chip').map((c) => c.props.label)).toEqual(['Received stock', 'Damaged', 'Manual correction', 'Count reconcile', 'Customer return']);
    expect(ofType(tree, 'Chip')[0].props.selected).toBe(true);
    expect(pill(tree, 'Apply').props.disabled).toBe(true);
    pill(tree, 'Cancel').props.onPress();
    expect(pressable(stockTool(rice()), 'Adjust stock: Rice 5 lb')).toBeTruthy();
  });

  it('Apply sends the amount and reason with one key per entry; a retry of the same entry keeps its key', () => {
    let tree = stockTool(rice());
    pressable(tree, 'Adjust stock: Rice 5 lb').props.onPress();
    tree = stockTool(rice());
    ofType(tree, 'InlineInput')[0].props.onChangeText('-3');
    tree = stockTool(rice());
    ofType(tree, 'Chip').find((c) => c.props.label === 'Damaged').props.onPress();
    tree = stockTool(rice());
    pill(tree, 'Apply').props.onPress();
    expect(h.adjusts).toHaveLength(1);
    const first = h.adjusts[0]!.vars;
    expect(first).toMatchObject({ itemId: 'r1', delta: -3, reason: 'DAMAGED' });
    expect(first.commandKey).toMatch(/^stock-key-/);
    h.adjusts[0]!.options.onError({ response: { data: { error: { message: 'Stock cannot go below zero' } } } });
    tree = stockTool(rice());
    expect(texts(tree)).toContain('Stock cannot go below zero');
    pill(tree, 'Apply').props.onPress();
    expect(h.adjusts[1]!.vars.commandKey, 'the same entry again: the same key').toBe(first.commandKey);
    ofType(tree, 'InlineInput')[0].props.onChangeText('-2');
    tree = stockTool(rice());
    pill(tree, 'Apply').props.onPress();
    expect(h.adjusts[2]!.vars.commandKey, 'a changed entry: a new key').not.toBe(first.commandKey);
    h.adjusts[2]!.options.onSuccess();
    expect(pressable(stockTool(rice()), 'Adjust stock: Rice 5 lb'), 'closes after it is applied').toBeTruthy();
  });

  it('only a whole, non-zero number within the server\'s bound can be applied', () => {
    for (const typed of ['', '0', '1.5', 'ten', '100001']) {
      h.state = [];
      pressable(stockTool(rice()), 'Adjust stock: Rice 5 lb').props.onPress();
      ofType(stockTool(rice()), 'InlineInput')[0].props.onChangeText(typed);
      expect(pill(stockTool(rice()), 'Apply').props.disabled, typed).toBe(true);
    }
    h.state = [];
    pressable(stockTool(rice()), 'Adjust stock: Rice 5 lb').props.onPress();
    ofType(stockTool(rice()), 'InlineInput')[0].props.onChangeText('+24');
    expect(pill(stockTool(rice()), 'Apply').props.disabled).toBe(false);
  });
});
