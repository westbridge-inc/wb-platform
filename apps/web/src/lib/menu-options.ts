/**
 * [W6] An item's choices on the website, judged by the API's own rules.
 *
 * The one validator the server runs at cart add, cart update and checkout
 * (apps/api/src/modules/order/options.ts, #1493) is imported here by path —
 * never re-expressed — so the store page can never accept a selection the
 * server would refuse, or price one differently. It is a pure module with no
 * imports; apps/web/Dockerfile copies exactly that file into the image build
 * (src/image-build-context.test.ts keeps the two in step).
 *
 * The page's figures are a preview. The server re-prices every line when it is
 * added and again at checkout.
 */
import { parseAmount } from './money';
import { resolveSelectedOptions, validateSelectedOptions } from '../../../api/src/modules/order/options';
import { basePrice, type PricedGroup, type PricedItem } from './menu-prices';

export { OptionSelectionError, resolveSelectedOptions, validateSelectedOptions } from '../../../api/src/modules/order/options';
export type { OptionSelection, OptionSelectionReason, ValidatableGroup } from '../../../api/src/modules/order/options';
export { basePrice, fromPrice, isPlainLine, needsChoices, noteIsEmpty, opensChoices, requiredChoiceSoldOut, requiredCount } from './menu-prices';

/**
 * One unit's price with these choices: the item's price plus each chosen
 * choice's price, resolved against the item's OWN groups by the API's
 * resolver. Null when any figure cannot be read.
 */
export function selectionPrice(item: PricedItem, selected: Record<string, string[]>): number | null {
  const base = basePrice(item);
  if (base === null) return null;
  let total = base;
  for (const option of resolveSelectedOptions(item, selected)) {
    const extra = parseAmount(option.additionalPrice);
    if (extra === null) return null;
    total += extra;
  }
  return total;
}

/** True when the server's validator would accept these choices for this item. */
export function selectionComplete(item: { optionGroups?: PricedGroup[] | null }, selected: Record<string, string[]>): boolean {
  try {
    validateSelectedOptions(item as Parameters<typeof validateSelectedOptions>[0], selected);
    return true;
  } catch {
    return false;
  }
}
