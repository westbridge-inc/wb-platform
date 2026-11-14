// ---------------------------------------------------------------------------
// [MENU-SEARCH · owner 14 Nov 2026] FINDING AN ITEM IN THE STORE'S OWN LIST.
//
// A store with hundreds of items (Parampara: 328) finds the one to edit, switch off or delete by typing, on the phone,
// the tablet and the website alike. The app's Menu / Products / Services tab (VendorMenuScreen) and the website's
// menu page (apps/web/src/app/dashboard/inventory) both filter with THIS file, so the same words find the same items
// in both (owner rule: the app and the website match).
//
// Both screens already hold every item of the store (GET /vendor/categories and GET /vendor/items are not paged), so
// the search runs on the list on screen: offline, and with no server round trip per key.
//
//   - the item's name, its SKU and the names of the choices in its options (a size, a topping);
//   - lower or upper case, with or without accents ("creme" finds "Crème");
//   - what was typed, inside one of those (part of a word is enough: "burger" finds "Cheeseburger") — the website's
//     rule since it first had a search box;
//   - or every word typed, in any order, each at the start of a word ("rice white" finds "White Rice"; "product 1"
//     does not find "Product 21").
//
// Pure on purpose: no React, no React Native, so the website can import it and the suite can test it in node.
// ---------------------------------------------------------------------------

/** The search box's words, as on the website since it first had one. */
export const CATALOGUE_SEARCH_PLACEHOLDER = 'Search name or SKU';

/** The longest search read: a pasted page is not a search. */
export const MAX_CATALOGUE_SEARCH = 100;

/** The "Low stock only" alert level when the item has none of its own (the website's rule). */
const DEFAULT_LOW_STOCK_AT = 5;

/** Lower-cased, accents off, runs of spaces made one: "  Crème  BRÛLÉE " -> "creme brulee". */
export function foldText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  let text = value.toLowerCase();
  try {
    text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch {
    // An engine without normalize: case still folds.
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** The words typed (split on spaces only, so a SKU like "AB-12" stays one word). None = no search. */
export function searchTerms(query: string): string[] {
  const folded = foldText(String(query ?? '').slice(0, MAX_CATALOGUE_SEARCH));
  return folded ? folded.split(' ') : [];
}

type Searchable = { name?: unknown; sku?: unknown; optionGroups?: unknown };

/** Each field on its own line: a word typed never matches across two fields run together. */
const haystacks = new WeakMap<object, string>();
function haystackOf(item: Searchable): string {
  const cached = haystacks.get(item);
  if (cached !== undefined) return cached;
  const fields: string[] = [foldText(item.name), foldText(item.sku)];
  if (Array.isArray(item.optionGroups)) {
    for (const group of item.optionGroups as unknown[]) {
      const options = (group as { options?: unknown } | null)?.options;
      if (!Array.isArray(options)) continue;
      for (const option of options as unknown[]) fields.push(foldText((option as { name?: unknown } | null)?.name));
    }
  }
  const haystack = fields.filter(Boolean).join('\n');
  haystacks.set(item, haystack);
  return haystack;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Whether the word is found where a word starts (the text's start, or after a space or a mark like "-" or "("). */
function startsAWord(haystack: string, word: string): boolean {
  for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + 1)) {
    if (at === 0 || !LETTER_OR_DIGIT.test(haystack[at - 1]!)) return true;
  }
  return false;
}

/** Whether the item's name, SKU or option names hold what was typed (anywhere, as typed), or every word typed, each
 *  at the start of a word, in any order. No words: every item. */
export function itemMatches(item: Searchable, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = haystackOf(item);
  if (haystack.includes(terms.join(' '))) return true;
  return terms.length > 1 && terms.every((term) => startsAWord(haystack, term));
}

type Stocked = { stockQuantity?: number | null; lowStockThreshold?: number | null };

/** The website's "Low stock only": a counted item at or under its alert level (5 when it has none). */
export function isLowStockItem(item: Stocked): boolean {
  return item.stockQuantity != null && item.stockQuantity <= (item.lowStockThreshold ?? DEFAULT_LOW_STOCK_AT);
}

/** "Low stock only" is offered only when some item's stock is counted (a restaurant's never is). */
export function tracksAnyStock(items: readonly Stocked[]): boolean {
  return items.some((item) => item.stockQuantity != null);
}

/** "1 item", "328 items". */
export function itemCountLine(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

const SHOWN_QUERY_LENGTH = 40;

/** The answer when nothing matches, naming what was typed. */
export function noMatchLine(query: string): string {
  const typed = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (!typed) return 'No items match.';
  const shown = typed.length > SHOWN_QUERY_LENGTH ? `${typed.slice(0, SHOWN_QUERY_LENGTH)}…` : typed;
  return `No items match “${shown}”.`;
}

type Section = { items?: ReadonlyArray<Searchable & Stocked> | null };
type ItemOf<C extends Section> = NonNullable<C['items']>[number];

/**
 * The app's sections with only the items that match. Nothing typed and no filter: every section (an empty one too)
 * and every item, as before. Filtering: a section with no match is left out. Each section is passed on whole (its
 * heading counts, renames and deletes the whole section, never the matches only), next to its matched items.
 */
export function filterCatalogue<C extends Section>(
  categories: readonly C[],
  { terms, lowOnly }: { terms: readonly string[]; lowOnly: boolean },
): { filtering: boolean; sections: Array<{ category: C; items: Array<ItemOf<C>> }>; count: number } {
  const filtering = terms.length > 0 || lowOnly;
  const sections: Array<{ category: C; items: Array<ItemOf<C>> }> = [];
  let count = 0;
  for (const category of categories) {
    const all = (Array.isArray(category.items) ? category.items : []) as Array<ItemOf<C>>;
    const items = filtering ? all.filter((item) => (!lowOnly || isLowStockItem(item)) && itemMatches(item, terms)) : all;
    if (filtering && items.length === 0) continue;
    sections.push({ category, items });
    count += items.length;
  }
  return { filtering, sections, count };
}
