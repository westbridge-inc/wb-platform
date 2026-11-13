/**
 * [W6 · size] What the store page needs at FIRST PAINT to list an item: its price, whether Add opens its choices,
 * its "From" figure, and whether a cart line is the plain one-tap line. Nothing here imports the API's option engine
 * (apps/api/src/modules/order/options.ts): that module judges and prices a SELECTION, which only happens once the
 * item sheet is open, so it rides in the sheet's chunk (item-sheet.tsx re-exports it; lib/menu-options.ts is the
 * full module). Importing the engine here would put all of it in the store page's first-load JavaScript.
 *
 * Nor does it import the phone's sheet model (apps/mobile/src/lib/menuSheet.ts): what a tap does to a selection is
 * also sheet-time code. The four small rules the list needs are restated here and pinned by lib/menu-options.test.ts
 * to their sources: `noteIsEmpty` and `halfPrice` to the engine's `normalizeItemNote` and `halfPrice`,
 * `requiredGroup` and `followUpGroupIds` to the sheet model's own.
 */
import { parseAmount } from './money';

export type PricedOption = { id: string; name: string; additionalPrice: unknown; isAvailable?: boolean | null; isDefault?: boolean; sortOrder?: number | null; followUpGroupId?: string | null };
export type PricedGroup = {
  id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: PricedOption[];
  sortOrder?: number | null; setsPrice?: boolean | null; allowHalves?: boolean | null; halfPricePercent?: number | null;
};
export type PricedItem = { basePrice: unknown; customerPrice?: unknown; optionGroups?: PricedGroup[] | null };

/** The server's note rule (`normalizeItemNote` in the API engine): a note that trims to nothing is no note. */
export function noteIsEmpty(note: string | null | undefined): boolean {
  return (note ?? '').trim().length === 0;
}

/** The sheet model's rule: the group must be answered (a size always must: the API requires it). */
export const requiredGroup = (group: PricedGroup): boolean => group.isRequired || group.setsPrice === true;

/** The sheet model's rule: the groups some choice of THIS item opens (a follow-up group, one level deep). */
export function followUpGroupIds(groups: readonly PricedGroup[]): Set<string> {
  const ids = new Set(groups.map((g) => g.id));
  const targets = new Set<string>();
  for (const g of groups) for (const o of g.options) if (o.followUpGroupId && ids.has(o.followUpGroupId) && o.followUpGroupId !== g.id) targets.add(o.followUpGroupId);
  return targets;
}

/** The server's half price (`halfPrice` in the API engine), for the "From" figure only: the store's percent of the
 *  choice's price, half-up to the whole dollar; 100% (or an unreadable percent) is the full price. */
export function halfPrice(price: number, percent: number): number {
  const pct = Number.isInteger(percent) && percent >= 1 && percent <= 100 ? percent : 100;
  if (pct === 100) return price;
  const cents = Math.round(price * 100);
  return Math.floor((cents * pct + 5000) / 10000);
}


/** The item's own price, or null when the server's figure cannot be read. */
export function basePrice(item: PricedItem): number | null {
  return parseAmount(item.customerPrice ?? item.basePrice);
}

/** How many choices a group needs before the item can be added (the validator's rule for an empty group; a size is
 *  always needed). */
export function requiredCount(group: PricedGroup): number {
  return requiredGroup(group) ? Math.max(1, group.minSelect) : 0;
}

/** The groups needed whatever is chosen: every required group except a follow-up one (needed only once opened). */
function alwaysRequired(item: PricedItem): PricedGroup[] {
  const groups = item.optionGroups ?? [];
  const followUps = followUpGroupIds(groups);
  return groups.filter((group) => !followUps.has(group.id) && requiredCount(group) > 0);
}

/** The item cannot be added without opening its choices (a required group, or a size). */
export function needsChoices(item: PricedItem): boolean {
  return alwaysRequired(item).length > 0;
}

/**
 * The item's Add opens its choices first: a choice is required, or the store
 * pre-selects one (the phone app pre-selects the same picks). One tap must
 * neither drop a store's pick from the order nor add it, and its price, unseen.
 */
export function opensChoices(item: PricedItem): boolean {
  return needsChoices(item)
    || (item.optionGroups ?? []).some((group) => group.setsPrice === true || group.allowHalves === true
      || group.options.some((option) => (option.isDefault === true && option.isAvailable !== false) || !!option.followUpGroupId));
}

/**
 * A required group has fewer choices on sale than it needs, so the item
 * cannot be ordered with any selection right now (the sheet says which).
 */
export function requiredChoiceSoldOut(item: PricedItem): boolean {
  return alwaysRequired(item).some((group) =>
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
  for (const group of alwaysRequired(item)) {
    const needed = requiredCount(group);
    const deltas: number[] = [];
    for (const option of group.options) {
      if (option.isAvailable === false) continue;
      const delta = parseAmount(option.additionalPrice);
      if (delta === null) return null;
      // [MENU-OPTIONS] A topping may go on one half, at the store's half price.
      deltas.push(group.allowHalves === true ? Math.min(delta, halfPrice(delta, group.halfPricePercent ?? 100)) : delta);
    }
    deltas.sort((a, b) => a - b);
    // [MENU-OPTIONS] A size IS the price: the cheapest size on sale replaces the item's price, never adds to it.
    if (group.setsPrice === true) total += deltas[0]! - base;
    else for (const delta of deltas.slice(0, needed)) total += delta;
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
