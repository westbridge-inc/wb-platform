import type { Prisma } from '@prisma/client';
import { vatTermsByVendor } from './order-vat';

// ---------------------------------------------------------------------------
// [STORE-VAT-EXCLUSIVE · REVIEW-B S3-1] "+ VAT" on EVERY price surface, not only the store page.
//
// A store pricing before VAT shows its prices as typed; a standard-rated price of such a store says "+ VAT" wherever it
// is shown: search, the market feed, trending, Home's dish rails, the cart lines. Each of those lists items outside
// their store, so the server says it per item (`vatAddedAtCheckout`), read live (a store's basis or an item's class may
// have changed since a cached rail or a search document was built). The apps never decide it themselves.
// ---------------------------------------------------------------------------

/** True only for a STANDARD-rated item (an unmarked item counts as standard) of a store whose VAT is added on top. */
export function vatAddedAtCheckout(storeOnTop: boolean, vatClass: string | null | undefined): boolean {
  return storeOnTop && vatClass !== 'ZERO_RATED' && vatClass !== 'EXEMPT';
}

/** Each listed item, with `vatAddedAtCheckout`. One store read; the items' classes are read only when a store in the list
 *  prices before VAT (every other list costs that one read). */
export async function withVatAddedHint<T extends { id: string; vendorId: string }>(
  db: Pick<Prisma.TransactionClient, 'vendor' | 'item'>, hits: readonly T[],
): Promise<Array<T & { vatAddedAtCheckout: boolean }>> {
  if (hits.length === 0) return [];
  const terms = await vatTermsByVendor(db, hits.map((h) => h.vendorId));
  const onTopStores = new Set([...terms.entries()].filter(([, t]) => t.onTop).map(([id]) => id));
  if (onTopStores.size === 0) return hits.map((h) => ({ ...h, vatAddedAtCheckout: false }));
  const ids = hits.filter((h) => onTopStores.has(h.vendorId)).map((h) => h.id);
  const classes = new Map((await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, vatClass: true } })).map((i) => [i.id, i.vatClass as string] as const));
  return hits.map((h) => ({ ...h, vatAddedAtCheckout: onTopStores.has(h.vendorId) && classes.has(h.id) && vatAddedAtCheckout(true, classes.get(h.id)) }));
}
