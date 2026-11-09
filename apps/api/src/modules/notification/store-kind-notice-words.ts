/**
 * [STORE-WORDS sweep · owner 9 Nov 2026] What Swift tells a STORE about its own items, in its kind's words: a
 * clothing shop was told an item "was hidden from your menu". A restaurant keeps its words exactly; any other
 * store (and a store whose kind is not known) reads plain words. The apps carry the same rule
 * (apps/mobile/src/lib/storeKindWords.ts).
 */

/** The low-stock / sold-out notice a store's owner gets. */
export function lowStockNoticeWords(
  ev: { name: string; remaining: number; kind: 'low' | 'out' },
  vendorType?: string | null,
): { title: string; body: string } {
  if (ev.kind !== 'out') return { title: 'Low stock', body: `${ev.name} is down to ${ev.remaining} in stock.` };
  const where = vendorType === 'RESTAURANT' ? 'your menu' : 'your store';
  return { title: 'Item sold out', body: `${ev.name} sold out and was hidden from ${where}. Restock to bring it back.` };
}

/**
 * The Standing coaching card's line for a store. Two of the restaurant lines speak of a kitchen ("prep time",
 * "a dish"): any other store is coached in its own words. Every other line is the same for every store.
 */
const NOT_A_KITCHEN_COACHING: Record<string, string> = {
  'long-wait': 'Keep your ready time honest in the app — customers forgive a long quote, not a broken one.',
  'not-as-described': 'Update photos and descriptions when an item changes — the listing is a promise.',
};

export function storeCoachingLine(tag: string, restaurantLine: string | undefined, vendorType?: string | null): string | undefined {
  if (restaurantLine === undefined || vendorType === 'RESTAURANT') return restaurantLine;
  return NOT_A_KITCHEN_COACHING[tag] ?? restaurantLine;
}

/** The one-time "review your categories" notice: "Your menu" only for a restaurant. */
export function categoryReviewTitle(vendorType?: string | null): string {
  return vendorType === 'RESTAURANT' ? 'Your menu just got easier to find' : 'Your store just got easier to find';
}
