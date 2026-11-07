import { describe, expect, it } from 'vitest';
import { firstLineByItem, storeMenuRows } from './storeMenuRows';

// [APP-SPEED C] The store page's menu as the rows of one virtualised list (FlashList). Pins the shape: every item the
// old page drew is a row (nothing dropped, nothing doubled), in the same order, with the category card's ends marked.

const item = (id: string) => ({ id, name: id });
const categories = [
  { id: 'mains', name: 'Mains', items: [item('curry'), item('pepperpot'), item('cookup')] },
  { id: 'empty', name: 'Nothing yet', items: [] },
  { id: 'drinks', name: 'Drinks', items: [item('mauby')] },
];
const allItems = categories.flatMap((c) => c.items);

describe('[APP-SPEED C] storeMenuRows', () => {
  it('a restaurant: each category with items is a title row then its items; the first and last close the card', () => {
    const rows = storeMenuRows({ mode: 'menu', categories, menuCatId: null, martItems: [], allItems });
    expect(rows.map((r) => r.key)).toEqual([
      'section:mains', 'item:mains:curry', 'item:mains:pepperpot', 'item:mains:cookup', 'section:drinks', 'item:drinks:mauby',
    ]);
    const items = rows.filter((r) => r.kind === 'item') as Array<{ key: string; first: boolean; last: boolean }>;
    expect(items.map((r) => [r.first, r.last])).toEqual([[true, false], [false, false], [false, true], [true, true]]);
  });

  it('a menu chip shows that category only', () => {
    const rows = storeMenuRows({ mode: 'menu', categories, menuCatId: 'drinks', martItems: [], allItems });
    expect(rows.map((r) => r.key)).toEqual(['section:drinks', 'item:drinks:mauby']);
  });

  it('an item listed in two categories is two rows with different keys', () => {
    const twice = [{ id: 'a', items: [item('x')] }, { id: 'b', items: [item('x')] }];
    const keys = storeMenuRows({ mode: 'menu', categories: twice, menuCatId: null, martItems: [], allItems: [] }).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a shop: the shelf three tiles to a row, every tile once, in order', () => {
    const shelf = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(item);
    const rows = storeMenuRows({ mode: 'mart', categories, menuCatId: null, martItems: shelf, allItems });
    expect(rows.map((r) => (r.kind === 'tiles' ? r.items.map((i) => i.id) : []))).toEqual([['a', 'b', 'c'], ['d', 'e', 'f'], ['g']]);
    expect(rows.map((r) => (r.kind === 'tiles' ? r.first : null))).toEqual([true, false, false]);
    expect(storeMenuRows({ mode: 'mart', categories, menuCatId: null, martItems: [], allItems })).toEqual([]);
  });

  it('a services store: one row per service', () => {
    const rows = storeMenuRows({ mode: 'services', categories, menuCatId: null, martItems: [], allItems });
    expect(rows.map((r) => r.key)).toEqual(allItems.map((i) => `service:${i.id}`));
  });

  it('firstLineByItem: the first line of each item, as the page found it before', () => {
    const lines = [{ id: 'l1', itemId: 'curry' }, { id: 'l2', itemId: 'curry' }, { id: 'l3', itemId: null }, { id: 'l4', itemId: 'mauby' }];
    const map = firstLineByItem(lines);
    expect(map.get('curry')?.id).toBe('l1');
    expect(map.get('mauby')?.id).toBe('l4');
    expect(map.size).toBe(2);
    expect(firstLineByItem(undefined).size).toBe(0);
  });
});
