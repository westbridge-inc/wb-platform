import { describe, expect, it, vi } from 'vitest';

// lib/images reads the API address from services/api (React Native): a stand-in here, the photo rule needs none.
vi.mock('../services/api', () => ({ API_URL: 'https://api.test' }));
import { isKeptPhoto } from './images';
import {
  CATALOGUE_FILTER_WORDS,
  CATALOGUE_SEARCH_PLACEHOLDER,
  filterCount,
  filterShownLine,
  hasCustomerPhoto,
  matchesFilter,
  offeredFilters,
  filterCatalogue,
  foldText,
  isLowStockItem,
  itemCountLine,
  itemMatches,
  noMatchLine,
  searchTerms,
  tracksAnyStock,
} from './catalogueSearch';

// [MENU-SEARCH · owner 14 Nov 2026] A store with 328 items finds the one to edit, switch off or delete by typing, on the
// phone, the tablet and the website alike: the website's "Search name or SKU" box (dashboard/inventory) and the app's
// Menu tab use THIS matcher, so the same words find the same items in both.

const item = (over: Record<string, unknown> = {}) => ({ id: 'i', name: 'Chicken Curry', sku: null, isAvailable: true, stockQuantity: null, ...over });

describe('foldText: case, accents and spacing never decide a match', () => {
  it('lower-cases, takes accents off and collapses spaces', () => {
    expect(foldText('  Crème   BRÛLÉE ')).toBe('creme brulee');
    expect(foldText('Piña Colada')).toBe('pina colada');
    expect(foldText(null)).toBe('');
    expect(foldText(42)).toBe('');
  });
});

describe('searchTerms: the words typed', () => {
  it('splits on spaces only (a SKU keeps its dash), folded, empty for blanks', () => {
    expect(searchTerms(' Rice  WHITE ')).toEqual(['rice', 'white']);
    expect(searchTerms('AB-12')).toEqual(['ab-12']);
    expect(searchTerms('   ')).toEqual([]);
  });
  it('reads at most 100 characters (a pasted page is not a search)', () => {
    expect(searchTerms('a'.repeat(500))[0]).toHaveLength(100);
  });
});

describe('itemMatches: name, SKU and option names', () => {
  it('matches part of the name, any case, any accent', () => {
    expect(itemMatches(item(), searchTerms('curr'))).toBe(true);
    expect(itemMatches(item({ name: 'Crème brûlée' }), searchTerms('CREME'))).toBe(true);
    expect(itemMatches(item({ name: 'Creme brulee' }), searchTerms('crème'))).toBe(true);
    expect(itemMatches(item(), searchTerms('pizza'))).toBe(false);
  });
  it('matches the SKU', () => {
    expect(itemMatches(item({ sku: 'KFC-0042' }), searchTerms('kfc-004'))).toBe(true);
    expect(itemMatches(item({ sku: 'KFC-0042' }), searchTerms('0043'))).toBe(false);
  });
  it('matches a choice inside the item\'s options (e.g. a size or a topping)', () => {
    const pizza = item({ name: 'Large Pizza', optionGroups: [{ name: 'Toppings', options: [{ name: 'Pepperoni' }, { name: 'Jalapeño' }] }] });
    expect(itemMatches(pizza, searchTerms('jalapeno'))).toBe(true);
    expect(itemMatches(pizza, searchTerms('pepperoni large'))).toBe(true);
    // The group's own heading is not an item fact: "toppings" would match every pizza.
    expect(itemMatches(pizza, searchTerms('toppings'))).toBe(false);
  });
  it('what was typed is found anywhere, even inside a word (the website\'s rule since it first had a search)', () => {
    expect(itemMatches(item({ name: 'Double Cheeseburger' }), searchTerms('burger'))).toBe(true);
    // Two words out of order: each must start a word ("burger" is inside one).
    expect(itemMatches(item({ name: 'Double Cheeseburger' }), searchTerms('burger double'))).toBe(false);
    expect(itemMatches(item({ name: 'Double Cheeseburger' }), searchTerms('cheese dou'))).toBe(true);
    expect(itemMatches(item({ name: 'Product 21' }), searchTerms('product 2'))).toBe(true);
  });
  it('or every word, in any order, each at the start of a word', () => {
    expect(itemMatches(item({ name: 'White Rice 5 lb' }), searchTerms('rice white'))).toBe(true);
    expect(itemMatches(item({ name: 'White Rice 5 lb' }), searchTerms('rice brown'))).toBe(false);
    expect(itemMatches(item({ name: 'Chicken (Large)' }), searchTerms('large chick'))).toBe(true);
    // "1" is not the start of "21": the typed "product 1" never finds Product 21.
    expect(itemMatches(item({ name: 'Product 21' }), searchTerms('product 1'))).toBe(false);
    expect(itemMatches(item({ name: 'Product 21' }), searchTerms('1 product'))).toBe(false);
    expect(itemMatches(item({ name: 'Product 12' }), searchTerms('1 product'))).toBe(true);
  });
  it('a word never matches across two fields joined together', () => {
    expect(itemMatches(item({ name: 'Tea', sku: 'pot' }), searchTerms('teapot'))).toBe(false);
  });
  it('no words = every item; odd shapes never throw', () => {
    expect(itemMatches(item(), [])).toBe(true);
    expect(itemMatches({ name: undefined, optionGroups: 'x' } as never, searchTerms('a'))).toBe(false);
    expect(itemMatches({ name: 'A', optionGroups: [null, { options: [null, { name: 7 }] }] } as never, searchTerms('a'))).toBe(true);
  });
});

describe('low stock: ONE rule for the filter, the row pill, the alerts card and the website\'s row [REVIEW #2514 S4-3]', () => {
  it('a counted item at 0, or at or under its OWN alert level (no level, no "low" above 0)', () => {
    expect(isLowStockItem(item({ stockQuantity: 5, lowStockThreshold: 5 }))).toBe(true);
    expect(isLowStockItem(item({ stockQuantity: 6, lowStockThreshold: 5 }))).toBe(false);
    expect(isLowStockItem(item({ stockQuantity: 9, lowStockThreshold: 10 }))).toBe(true);
    expect(isLowStockItem(item({ stockQuantity: 0 }))).toBe(true);
    expect(isLowStockItem(item({ stockQuantity: -2 }))).toBe(true);
    expect(isLowStockItem(item({ stockQuantity: 3 })), 'no alert level set: 3 left is not "low"').toBe(false);
    expect(isLowStockItem(item({ stockQuantity: 3, lowStockThreshold: null }))).toBe(false);
    expect(isLowStockItem(item({ stockQuantity: null }))).toBe(false);
    expect(isLowStockItem(item({ stockQuantity: undefined }))).toBe(false);
  });
  it('tracksAnyStock: the filter is offered only when some item is counted', () => {
    expect(tracksAnyStock([item(), item({ stockQuantity: 3 })])).toBe(true);
    expect(tracksAnyStock([item(), item()])).toBe(false);
  });
});

describe('words on screen', () => {
  it('the count, the empty answer and the box\'s words', () => {
    expect(itemCountLine(1)).toBe('1 item');
    expect(itemCountLine(0)).toBe('0 items');
    expect(itemCountLine(328)).toBe('328 items');
    expect(noMatchLine('  pizza ')).toBe('No items match “pizza”.');
    expect(noMatchLine('')).toBe('No items match.');
    expect(noMatchLine('x'.repeat(80))).toBe(`No items match “${'x'.repeat(40)}…”.`);
    expect(CATALOGUE_SEARCH_PLACEHOLDER).toBe('Search name or SKU');
  });
});

describe('filterCatalogue: the app\'s sections, filtered', () => {
  const menu = [
    { id: 'c1', name: 'Mains', items: [item({ id: 'a', name: 'Chicken Curry' }), item({ id: 'b', name: 'Beef Stew', stockQuantity: 2, lowStockThreshold: 3 })] },
    { id: 'c2', name: 'Drinks', items: [item({ id: 'c', name: 'Mauby' }), item({ id: 'd', name: 'Chicken Soup' })] },
    { id: 'c3', name: 'Empty', items: [] },
  ];
  it('nothing typed: every section, the empty one too, every item', () => {
    const out = filterCatalogue(menu, { terms: [], filter: null });
    expect(out.filtering).toBe(false);
    expect(out.sections.map((s) => s.category.id)).toEqual(['c1', 'c2', 'c3']);
    expect(out.count).toBe(4);
  });
  it('a search keeps only matched items, under their own section, in menu order; sections with none drop', () => {
    const out = filterCatalogue(menu, { terms: searchTerms('chicken'), filter: null });
    expect(out.filtering).toBe(true);
    expect(out.sections.map((s) => [s.category.id, s.items.map((i) => i.id)])).toEqual([['c1', ['a']], ['c2', ['d']]]);
    expect(out.count).toBe(2);
  });
  it('the section keeps its full self (its heading counts and deletes every item, not just the matches)', () => {
    const out = filterCatalogue(menu, { terms: searchTerms('chicken'), filter: null });
    expect(out.sections[0]!.category).toBe(menu[0]);
  });
  it('a filter button, alone or with words', () => {
    expect(filterCatalogue(menu, { terms: [], filter: 'LOW_STOCK' }).sections.map((s) => s.items.map((i) => i.id))).toEqual([['b']]);
    expect(filterCatalogue(menu, { terms: searchTerms('curry'), filter: 'LOW_STOCK' }).count).toBe(0);
  });
  it('a section without an items list is read as empty', () => {
    expect(filterCatalogue([{ id: 'x', name: 'X', items: null }], { terms: searchTerms('a'), filter: null }).sections).toEqual([]);
    expect(filterCatalogue([{ id: 'x', name: 'X', items: null }], { terms: [], filter: null }).sections[0]!.items).toEqual([]);
  });
});

// [MENU-FILTERS · parity audit C1, owner 14 Nov 2026] The filter buttons next to the search, the same on the app and the
// website: Sold out, Low stock (only for a store that counts stock), No photo. One at a time; tapped again, it is off.
describe('filter buttons', () => {
  it('their words, in this order', () => {
    expect(CATALOGUE_FILTER_WORDS).toEqual({ SOLD_OUT: 'Sold out', LOW_STOCK: 'Low stock', NO_PHOTO: 'No photo' });
    expect(offeredFilters([item({ stockQuantity: 2 })])).toEqual(['SOLD_OUT', 'LOW_STOCK', 'NO_PHOTO']);
  });
  it('Low stock is offered only when some item counts stock (never a restaurant\'s)', () => {
    expect(offeredFilters([item(), item()])).toEqual(['SOLD_OUT', 'NO_PHOTO']);
  });
  it('Sold out: switched off by the store (the server\'s isAvailable false)', () => {
    expect(matchesFilter(item({ isAvailable: false }), 'SOLD_OUT')).toBe(true);
    expect(matchesFilter(item({ isAvailable: true }), 'SOLD_OUT')).toBe(false);
    expect(matchesFilter(item({ isAvailable: undefined }), 'SOLD_OUT')).toBe(false);
  });
  it('Low stock: the one rule (at 0, or at or under the item\'s own alert level)', () => {
    expect(matchesFilter(item({ stockQuantity: 5, lowStockThreshold: 5 }), 'LOW_STOCK')).toBe(true);
    expect(matchesFilter(item({ stockQuantity: 5 }), 'LOW_STOCK')).toBe(false);
    expect(matchesFilter(item({ stockQuantity: 0 }), 'LOW_STOCK')).toBe(true);
  });
  it('No photo: no photo customers see (none, or an outside address that is no longer shown)', () => {
    expect(matchesFilter(item({ imageUrl: null }), 'NO_PHOTO')).toBe(true);
    expect(matchesFilter(item({ imageUrl: '' }), 'NO_PHOTO')).toBe(true);
    expect(matchesFilter(item({ imageUrl: 'https://example.com/a.jpg' }), 'NO_PHOTO')).toBe(true);
    expect(matchesFilter(item({ imageUrl: 'stores/v1/items/a.jpg' }), 'NO_PHOTO')).toBe(false);
  });
  it('the photo rule is the app\'s own (lib/images isKeptPhoto), address for address', () => {
    for (const url of [null, undefined, '', 'stores/a.jpg', '/stores/a.jpg', 'https://x.test/a.jpg', 'data:image/png;base64,x', '../a', 'a b.jpg']) {
      expect(hasCustomerPhoto({ imageUrl: url }), String(url)).toBe(isKeptPhoto(url));
    }
  });
  it('no button: every item', () => {
    expect(matchesFilter(item({ isAvailable: false }), null)).toBe(true);
  });
  it('how many each button holds', () => {
    const items = [item({ isAvailable: false }), item({ isAvailable: false, imageUrl: 'stores/a.jpg' }), item({ stockQuantity: 0 })];
    expect(filterCount(items, 'SOLD_OUT')).toBe(2);
    expect(filterCount(items, 'LOW_STOCK')).toBe(1);
    expect(filterCount(items, 'NO_PHOTO')).toBe(2);
  });
  it('the line under an empty answer says which button is on', () => {
    expect(filterShownLine('SOLD_OUT')).toBe('Showing sold out items only.');
    expect(filterShownLine('LOW_STOCK')).toBe('Showing low stock items only.');
    expect(filterShownLine('NO_PHOTO')).toBe('Showing items with no photo only.');
  });
  it('filterCatalogue applies a button with a search', () => {
    const menu = [{ id: 'c', name: 'C', items: [item({ id: 'a', name: 'Rice', isAvailable: false }), item({ id: 'b', name: 'Rice Bag' }), item({ id: 'd', name: 'Flour', isAvailable: false })] }];
    expect(filterCatalogue(menu, { terms: searchTerms('rice'), filter: 'SOLD_OUT' }).sections[0]!.items.map((i) => i.id)).toEqual(['a']);
    expect(filterCatalogue(menu, { terms: [], filter: 'SOLD_OUT' }).count).toBe(2);
  });
});
