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
 *
 * [MENU-OPTIONS · owner 11 Nov 2026] Pizza-grade choices: a size SETS the item
 * price (lineBasePrice), a half topping costs the store's half price
 * (halfPrice), a follow-up group opens under the option that opens it. What a
 * tap does to the selection is the phone's own sheet model
 * (apps/mobile/src/lib/menuSheet.ts, import-free, imported here by path so the
 * phone and the site behave the same; apps/web/Dockerfile copies it too).
 */
import { parseAmount } from './money';
import { lineBasePrice, resolveSelectedOptions, validateSelectedOptions } from '../../../api/src/modules/order/options';
import { basePrice, type PricedGroup, type PricedItem } from './menu-prices';

export { halfPrice, OptionSelectionError, resolveSelectedOptions, validateSelectedOptions } from '../../../api/src/modules/order/options';
export type { OptionSelection, OptionSelectionReason, ValidatableGroup } from '../../../api/src/modules/order/options';
export {
  chooseOption, choiceId, defaultSelection, followUpFor, groupGuidance, hasSizes, isChosen, onSale,
  orderLineChoices, placeOption, placementOf, restoreSelection, singleChoice, clearableSingle, maxChoices, requiredGroup,
  sortedOptions, topLevelGroups, wireSelection,
} from '../../../mobile/src/lib/menuSheet';
export type { ChoiceLine, OrderLineChoice, Placement, SheetGroup, SheetSelection } from '../../../mobile/src/lib/menuSheet';
export { basePrice, fromPrice, isPlainLine, needsChoices, noteIsEmpty, opensChoices, requiredChoiceSoldOut, requiredCount } from './menu-prices';

/**
 * One unit's price with these choices, resolved against the item's OWN groups
 * by the API's resolver: the chosen size's price (or the item's price), plus
 * each other choice (a half at the store's half price). Null when any figure
 * cannot be read.
 */
export function selectionPrice(item: PricedItem, selected: Record<string, string[]>): number | null {
  const itemPrice = basePrice(item);
  if (itemPrice === null) return null;
  const resolved = resolveSelectedOptions(item, selected);
  const base = parseAmount(lineBasePrice(itemPrice, resolved));
  if (base === null) return null;
  let total = base;
  for (const option of resolved) {
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

/** The choices' words as the cart shows them ("Large", "Pepperoni (left half)"): the API's own display words, so a
 *  browser basket line reads exactly like the saved cart line it becomes. */
export function selectionNames(item: PricedItem, selected: Record<string, string | string[]>): string[] {
  return resolveSelectedOptions(item, selected).map((option) => option.optionName);
}
