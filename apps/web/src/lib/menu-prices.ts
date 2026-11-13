/**
 * [W6 · size] What the store page needs at FIRST PAINT to list an item: its price, whether Add opens its choices,
 * its "From" figure, and whether a cart line is the plain one-tap line. Nothing here imports the API's option engine
 * (apps/api/src/modules/order/options.ts): that module judges and prices a SELECTION, which only happens once the
 * item sheet is open, so it rides in the sheet's chunk (item-sheet.tsx re-exports it; lib/menu-options.ts is the
 * full module). Importing the engine here would put all of it in the store page's first-load JavaScript.
 *
 * menu-prices.test.ts pins `noteIsEmpty` to the engine's own `normalizeItemNote`.
 */
import { parseAmount } from './money';

export type PricedOption = { id: string; name: string; additionalPrice: unknown; isAvailable?: boolean | null; isDefault?: boolean };
export type PricedGroup = { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: PricedOption[] };
export type PricedItem = { basePrice: unknown; customerPrice?: unknown; optionGroups?: PricedGroup[] | null };

/** The server's note rule (`normalizeItemNote` in the API engine): a note that trims to nothing is no note. */
export function noteIsEmpty(note: string | null | undefined): boolean {
  return (note ?? '').trim().length === 0;
}

/** The item's own price, or null when the server's figure cannot be read. */
export function basePrice(item: PricedItem): number | null {
  return parseAmount(item.customerPrice ?? item.basePrice);
}

/** How many choices a group needs before the item can be added (the validator's rule for an empty group). */
export function requiredCount(group: PricedGroup): number {
  return group.isRequired ? Math.max(1, group.minSelect) : 0;
}

/** The item cannot be added without opening its choices. */
export function needsChoices(item: PricedItem): boolean {
  return (item.optionGroups ?? []).some((group) => requiredCount(group) > 0);
}

/**
 * The item's Add opens its choices first: a choice is required, or the store
 * pre-selects one (the phone app pre-selects the same picks). One tap must
 * neither drop a store's pick from the order nor add it, and its price, unseen.
 */
export function opensChoices(item: PricedItem): boolean {
  return needsChoices(item)
    || (item.optionGroups ?? []).some((group) => group.options.some((option) => option.isDefault === true && option.isAvailable !== false));
}

/**
 * A required group has fewer choices on sale than it needs, so the item
 * cannot be ordered with any selection right now (the sheet says which).
 */
export function requiredChoiceSoldOut(item: PricedItem): boolean {
  return (item.optionGroups ?? []).some((group) =>
    group.options.filter((option) => option.isAvailable !== false).length < requiredCount(group));
}

/**
 * The lowest price the item can be ordered at: its price plus the cheapest
 * choices each required group needs, counting only choices on sale. This is
 * the "From" figure on the menu. Null when any figure in it cannot be read,
 * and when a required choice is sold out: no price can be ordered at then.
 */
export function fromPrice(item: PricedItem): number | null {
  const base = basePrice(item);
  if (base === null || requiredChoiceSoldOut(item)) return null;
  let total = base;
  for (const group of item.optionGroups ?? []) {
    const needed = requiredCount(group);
    if (needed === 0) continue;
    const deltas: number[] = [];
    for (const option of group.options) {
      if (option.isAvailable === false) continue;
      const delta = parseAmount(option.additionalPrice);
      if (delta === null) return null;
      deltas.push(delta);
    }
    deltas.sort((a, b) => a - b);
    for (const delta of deltas.slice(0, needed)) total += delta;
  }
  return total;
}

/**
 * A cart line in the item's plain configuration: no choice and no note —
 * exactly what one tap adds (the server keys a line by item, choices and the
 * note it normalises with `normalizeItemNote`: trimmed, empty = none).
 */
export function isPlainLine(line: { selectedOptions?: unknown; selectedOptionNames?: readonly string[] | null; specialInstructions?: string | null }): boolean {
  const selection = line.selectedOptions;
  const chosen = selection && typeof selection === 'object' && !Array.isArray(selection)
    ? Object.values(selection as Record<string, unknown>).some((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
    : false;
  return !chosen && (line.selectedOptionNames?.length ?? 0) === 0 && noteIsEmpty(line.specialInstructions);
}
