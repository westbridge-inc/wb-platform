/**
 * [APP-SPEED C] The store page's menu as the rows of one virtualised list (FlashList): only the rows near the screen
 * are drawn, so a supermarket with hundreds of items opens and scrolls like a small menu (this replaces the growing
 * "first 48, then 48 more" window, D6-MOB-01). Pure, so the shape is tested without a phone.
 *
 * - a restaurant: per category, its title row, then one row per item (the first and last of a category close the
 *   category's card above and below);
 * - a shop or supermarket: the shelf (aisle + in-store search already applied) three tiles to a row;
 * - a services store: one row per service.
 */
export type StoreMenuRow =
  | { kind: 'section'; key: string; cat: any }
  | { kind: 'item'; key: string; item: any; first: boolean; last: boolean }
  | { kind: 'tiles'; key: string; items: any[]; first: boolean }
  | { kind: 'service'; key: string; item: any; first: boolean };

export const TILES_PER_ROW = 3;

export function storeMenuRows(input: {
  mode: 'menu' | 'mart' | 'services';
  categories: any[];
  /** The menu chip picked (null: the full menu). */
  menuCatId: string | null;
  /** The shelf after the aisle and the in-store search (mart). */
  martItems: any[];
  /** Every item of every category (services). */
  allItems: any[];
}): StoreMenuRow[] {
  const rows: StoreMenuRow[] = [];
  if (input.mode === 'mart') {
    for (let i = 0; i < input.martItems.length; i += TILES_PER_ROW) {
      const items = input.martItems.slice(i, i + TILES_PER_ROW);
      rows.push({ kind: 'tiles', key: `tiles:${items.map((item) => item.id).join('|')}`, items, first: i === 0 });
    }
    return rows;
  }
  if (input.mode === 'services') {
    input.allItems.forEach((item, idx) => rows.push({ kind: 'service', key: `service:${item.id}`, item, first: idx === 0 }));
    return rows;
  }
  for (const cat of input.categories) {
    if (input.menuCatId && cat.id !== input.menuCatId) continue;
    const items: any[] = cat.items ?? [];
    if (items.length === 0) continue;
    rows.push({ kind: 'section', key: `section:${cat.id}`, cat });
    items.forEach((item, idx) => rows.push({
      kind: 'item', key: `item:${cat.id}:${item.id}`, item, first: idx === 0, last: idx === items.length - 1,
    }));
  }
  return rows;
}

/** The first cart line of each item (the store page's steppers follow the item's plain line, as before). */
export function firstLineByItem<L extends { itemId?: string | null }>(lines: L[] | null | undefined): Map<string, L> {
  const out = new Map<string, L>();
  for (const line of lines ?? []) if (line.itemId && !out.has(line.itemId)) out.set(line.itemId, line);
  return out;
}
