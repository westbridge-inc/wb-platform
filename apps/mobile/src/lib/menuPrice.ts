/**
 * [MENU-OPTIONS · owner 11 Nov 2026] The phone item sheet's live price and Add rule, by the server's own rules
 * (menuOptionsEngine.ts, pinned to apps/api/src/modules/order/options.ts): the chosen size IS the item price,
 * extras add on top, a half topping costs the store's half price, a follow-up choice adds its own price. The server
 * re-prices the line at cart add and at checkout; this is what the customer sees while choosing.
 */
import { lineBasePrice, optionsUnitPrice, resolveSelectedOptions, validateSelectedOptions, OptionSelectionError, type ValidatableGroup } from './menuOptionsEngine';
import type { SheetGroup, SheetSelection } from './menuSheet';

type PricedItem = { basePrice?: unknown; customerPrice?: unknown; optionGroups?: SheetGroup[] | null };

/** One unit's price with these choices; null when a figure the server sent cannot be read. */
export function sheetUnitPrice(item: PricedItem, selection: SheetSelection): number | null {
  const options = resolveSelectedOptions(item as Parameters<typeof resolveSelectedOptions>[0], selection);
  const base = lineBasePrice(item.customerPrice ?? item.basePrice, options);
  const extras = optionsUnitPrice(options);
  const unit = base + extras;
  return Number.isFinite(unit) ? unit : null;
}

/** A group as the validator reads it, with the rule fields an older or partial answer left out at their safest
 *  reading (the server's columns default the same way: not required, no minimum, pick one). */
function asValidatable(group: SheetGroup): ValidatableGroup {
  return {
    ...group,
    isRequired: group.isRequired === true,
    minSelect: Number.isInteger(group.minSelect) ? group.minSelect : 0,
    maxSelect: Number.isInteger(group.maxSelect) ? group.maxSelect : 1,
  } as ValidatableGroup;
}

/** Why the server would refuse these choices (the group's own words), or null when it would accept them. */
export function selectionProblem(item: { optionGroups?: SheetGroup[] | null }, selection: SheetSelection): string | null {
  try {
    validateSelectedOptions({ optionGroups: (item.optionGroups ?? []).map(asValidatable) }, selection);
    return null;
  } catch (error) {
    if (error instanceof OptionSelectionError) return error.message;
    throw error;
  }
}
