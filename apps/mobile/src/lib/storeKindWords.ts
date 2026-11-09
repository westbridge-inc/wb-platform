/**
 * [STORE-WORDS · owner 9 Nov 2026] A clothing shop's item page said "Note for the store — e.g. no onions,
 * extra pepper" and "30 min prep": a kitchen's words on a shop. The words a customer sees about a store
 * now follow the store's kind (Vendor.vendorType): a restaurant keeps its kitchen words exactly; a
 * supermarket, a shop and a service business get their own; a kind this build does not know gets
 * neutral words, never a kitchen's.
 *
 * Pure TypeScript (no React, no React Native, no Next). The website keeps a byte-identical copy at
 * apps/web/src/lib/store-kind-words.ts; its census test fails when the two differ.
 */

export type StoreKind = 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

export interface StoreKindWords {
  /** The hint inside an item's "Note for the store" box. */
  itemNotePlaceholder: string;
  /** Where the store keeps its items, as a customer would say it: "the menu", "the catalogue". */
  catalogue: string;
  /** The item page when the store took the item off sale. */
  itemGoneTitle: string;
  itemGoneBody: string;
  /** The line a table or counter QR opens the storefront with. */
  qrWelcome: string;
}

const RESTAURANT: StoreKindWords = {
  itemNotePlaceholder: 'e.g. no onions, extra pepper',
  catalogue: 'the menu',
  itemGoneTitle: 'This item is no longer on the menu.',
  itemGoneBody: 'The store took it off. Pick something else from its menu.',
  qrWelcome: 'Dining in? Browse our menu here and place your order with your server.',
};

const NOT_A_KITCHEN = {
  catalogue: 'the catalogue',
  itemGoneTitle: 'This item is no longer for sale.',
  itemGoneBody: 'The store took it off. Pick something else from the store.',
  qrWelcome: 'In the store? Browse what it sells here and order at the counter.',
} as const;

const WORDS: Record<StoreKind, StoreKindWords> = {
  RESTAURANT,
  SUPERMARKET: { ...NOT_A_KITCHEN, itemNotePlaceholder: 'e.g. ripe ones, no substitutes' },
  STORE: { ...NOT_A_KITCHEN, itemNotePlaceholder: 'e.g. size, colour, gift wrap' },
  SERVICE: {
    ...NOT_A_KITCHEN,
    itemNotePlaceholder: 'e.g. what you need, and anything that helps',
    itemGoneTitle: 'This is no longer offered.',
    itemGoneBody: 'The business took it off. Pick something else from its list.',
    catalogue: 'the list',
  },
};

/** A kind this build has no words for (or none sent): plain words that fit any store. */
const NEUTRAL: StoreKindWords = { ...NOT_A_KITCHEN, itemNotePlaceholder: 'Anything the store should know' };

export function isStoreKind(value: unknown): value is StoreKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WORDS, value);
}

/** The words for a store of this kind. Only a RESTAURANT gets a kitchen's words. */
export function storeKindWords(vendorType: string | null | undefined): StoreKindWords {
  return isStoreKind(vendorType) ? WORDS[vendorType] : NEUTRAL;
}

/**
 * How long until an order is ready, in the store's words: a restaurant "20 min prep"; any other store
 * "Ready in about 20 min". No time (missing, zero or not a number) is no line at all, never a guess.
 */
export function readyTimeLabel(vendorType: string | null | undefined, minutes: unknown): string | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return null;
  const m = Math.round(minutes);
  return vendorType === 'RESTAURANT' ? `${m} min prep` : `Ready in about ${m} min`;
}

/** The order page's estimate: a restaurant "About 20 min prep"; any other store "Ready in about 20 min". */
export function orderReadyEstimate(vendorType: string | null | undefined, minutes: unknown): string | null {
  const label = readyTimeLabel(vendorType, minutes);
  return label && vendorType === 'RESTAURANT' ? `About ${label}` : label;
}

/**
 * The heading over item results in a search filtered to this store kind: "Dishes" only for restaurants.
 * A search across every kind mixes a shop's goods in with the dishes (the website's words).
 */
export function searchItemsHeading(vendorType: string | null | undefined): string {
  if (vendorType === 'RESTAURANT') return 'Dishes';
  if (vendorType === 'SUPERMARKET') return 'Products';
  return 'Dishes and products';
}

/**
 * Rating tags that only make sense for food. A supermarket sells food too (fresh, frozen), so only a
 * shop and a service business lose them; every other tag is offered as the server sent it.
 */
export const FOOD_ONLY_RATING_TAGS: readonly string[] = ['tasty-food', 'cold-food'];

export function ratingTagFitsStore(slug: string, vendorType: string | null | undefined): boolean {
  if (vendorType !== 'STORE' && vendorType !== 'SERVICE') return true;
  return !FOOD_ONLY_RATING_TAGS.includes(slug);
}
