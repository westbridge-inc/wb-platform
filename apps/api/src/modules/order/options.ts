/**
 * Pricing for an item's selected options (size, add-ons…), and the ONE validator for a selection.
 *
 * `selectedOptions` is `{ [optionGroupId]: choice | choice[] }`, a choice being an option id, or for a half-and-half
 * group `<optionId>:left` / `<optionId>:right` (a bare id is the whole item). We resolve those ids against the item's
 * OWN option groups, so only options that genuinely belong to the item are ever priced — a client can't inject an
 * arbitrary priced option. Used by both the cart total and the order/checkout total so the two never disagree.
 *
 * [MENU-OPTIONS · owner 11 Nov 2026] The pizza rules, all decided here and nowhere else (the apps only display):
 *   - SIZE SETS THE PRICE: a group with `setsPrice` is pick-exactly-one; the chosen option's price IS the line's base
 *     price (the item's basePrice is then only the "from" price); every other choice adds on top. The size choice
 *     itself adds 0.
 *   - HALF-AND-HALF: in a group with `allowHalves` each choice is on the whole item, the left half or the right half;
 *     a half costs `halfPricePercent`% of the choice's price, half-up to the whole dollar (100% = the full price).
 *   - NESTED, one level: an option with `followUpGroupId` opens that group of the same item. The follow-up group is
 *     offered, required and priced only while one of its opening options is chosen; a choice in it without its
 *     opener is refused. A follow-up group's own options never open another (the store tools refuse that).
 */
export type Placement = 'WHOLE' | 'LEFT' | 'RIGHT';

export type ResolvedOption = {
  /** The DISPLAY words of the group, as every app (old and new) already shows them: the plain name, or for a
   *  follow-up group "Cheese (Stuffed crust)". */
  optionGroupName: string;
  /** The DISPLAY words of the choice: the plain name, or "Pepperoni (left half)" / "Pepperoni (right half)". */
  optionName: string;
  /** What this choice adds to the line's unit price (0 for the size choice: it IS the base). */
  additionalPrice: number;
  /** [MENU-OPTIONS] The parts, for the order snapshot and the kitchen view. */
  optionId: string;
  plainGroupName: string;
  plainOptionName: string;
  /** WHOLE | LEFT | RIGHT in a half-and-half group; null in any other group. */
  placement: Placement | null;
  /** The opener's name when this choice was made in a follow-up group. */
  parentOptionName: string | null;
  /** True for the size choice. */
  setsPrice: boolean;
  /** The choice's own menu price (the size price; a topping's full price before the half rule). */
  listedPrice: number;
};

/** What pricing reads of an option. */
type OptionLike = { id: string; name: string; additionalPrice: unknown; followUpGroupId?: string | null; isAvailable?: boolean | null; sortOrder?: number | null };
/** What pricing reads of a group. `id` is optional only for the legacy lenient reader's fixtures. */
type GroupLike = {
  id?: string; name: string; sortOrder?: number | null;
  setsPrice?: boolean | null; allowHalves?: boolean | null; halfPricePercent?: number | null;
  options: OptionLike[];
};
type ItemWithOptions = { optionGroups?: GroupLike[] | null };

/** [MENU-OPTIONS] The columns pricing and validation read, for a Prisma `select` of an item's groups. Every money
 *  path that SELECTS (rather than includes) groups uses this, so no reader can price without the pizza rules. */
export const OPTION_GROUPS_PRICING_SELECT = {
  id: true, name: true, isRequired: true, minSelect: true, maxSelect: true, sortOrder: true,
  setsPrice: true, allowHalves: true, halfPricePercent: true,
  options: { select: { id: true, name: true, additionalPrice: true, isAvailable: true, sortOrder: true, followUpGroupId: true } },
} as const;

const PLACEMENT_SUFFIX: Record<string, Placement> = { left: 'LEFT', right: 'RIGHT', whole: 'WHOLE' };

/** One choice as sent: `<id>` or `<id>:left|right|whole`. Null when it is not a string. */
function parseChoice(raw: unknown): { id: string; placement: Placement | null } | null {
  if (typeof raw !== 'string') return null;
  const at = raw.lastIndexOf(':');
  if (at > 0) {
    const placement = PLACEMENT_SUFFIX[raw.slice(at + 1)];
    if (placement) return { id: raw.slice(0, at), placement };
  }
  return { id: raw, placement: null };
}

/** The canonical form of a choice: a bare id for the whole item (or a group without halves), a suffix for a half. */
function canonicalChoice(id: string, placement: Placement | null): string {
  return placement === 'LEFT' ? `${id}:left` : placement === 'RIGHT' ? `${id}:right` : id;
}

/** [MENU-OPTIONS] A choice's price on one half: the store's percent of its price, half-up to the whole dollar.
 *  100% is the price itself, unrounded. Exact integer arithmetic (cents as BigInt). */
export function halfPrice(price: number, percent: number): number {
  const pct = Number.isInteger(percent) && percent >= 1 && percent <= 100 ? percent : 100;
  if (pct === 100) return price;
  const cents = BigInt(Math.round(price * 100));
  return Number((cents * BigInt(pct) + 5000n) / 10000n);
}

const byMenuOrder = <T extends { sortOrder?: number | null; id?: string }>(a: T, b: T) =>
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || ((a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0);

/** The groups some option of the item opens (follow-up groups), by id. */
function followUpGroupIds(groups: readonly GroupLike[]): Set<string> {
  const ids = new Set(groups.map((g) => g.id).filter((id): id is string => !!id));
  const targets = new Set<string>();
  for (const g of groups) for (const o of g.options) if (o.followUpGroupId && ids.has(o.followUpGroupId) && o.followUpGroupId !== g.id) targets.add(o.followUpGroupId);
  return targets;
}

/** The priced, display-ready choices, in menu order: each top-level group in turn, each follow-up choice right
 *  after the option that opened it. `chosen` maps option id -> the placement asked (null = whole/none). */
function emitResolved(groups: readonly GroupLike[], chosen: ReadonlyMap<string, Placement | null>): ResolvedOption[] {
  const sorted = [...groups].sort(byMenuOrder);
  const followUps = followUpGroupIds(sorted);
  const groupById = new Map(sorted.filter((g) => g.id).map((g) => [g.id!, g]));
  const out: ResolvedOption[] = [];
  const emitted = new Set<string>();
  const emitGroup = (group: GroupLike, parent: OptionLike | null) => {
    for (const option of [...group.options].sort(byMenuOrder)) {
      if (!chosen.has(option.id) || emitted.has(option.id)) continue;
      emitted.add(option.id);
      const price = Number(option.additionalPrice);
      const halves = group.allowHalves === true;
      const placement: Placement | null = halves ? (chosen.get(option.id) ?? 'WHOLE') : null;
      const setsPrice = group.setsPrice === true;
      const adds = setsPrice ? 0 : placement === 'LEFT' || placement === 'RIGHT' ? halfPrice(price, group.halfPricePercent ?? 100) : price;
      out.push({
        optionGroupName: parent ? `${group.name} (${parent.name})` : group.name,
        optionName: placement === 'LEFT' ? `${option.name} (left half)` : placement === 'RIGHT' ? `${option.name} (right half)` : option.name,
        additionalPrice: adds,
        optionId: option.id,
        plainGroupName: group.name,
        plainOptionName: option.name,
        placement,
        parentOptionName: parent ? parent.name : null,
        setsPrice,
        listedPrice: price,
      });
      if (!parent && option.followUpGroupId) {
        const next = groupById.get(option.followUpGroupId);
        if (next && followUps.has(next.id!)) emitGroup(next, option);
      }
    }
  };
  for (const group of sorted) if (!group.id || !followUps.has(group.id)) emitGroup(group, null);
  // A follow-up choice whose opener is not chosen (only a selection the validator refuses): priced, not hidden.
  for (const group of sorted) if (group.id && followUps.has(group.id)) emitGroup(group, null);
  return out;
}

/**
 * The LENIENT reader (the cart quote, and pricing after the validator accepted a selection): every chosen id that
 * belongs to the item is priced by its group's rules, wherever in the selection it was sent; anything else is
 * ignored. A selection the validator would refuse is never ordered (checkout validates first) and its quote line is
 * marked by lineOptionsIssue.
 */
export function resolveSelectedOptions(item: ItemWithOptions, selected: unknown): ResolvedOption[] {
  const groups = item.optionGroups ?? [];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return [];
  const known = new Set(groups.flatMap((g) => g.options.map((o) => o.id)));
  const chosen = new Map<string, Placement | null>();
  for (const value of Object.values(selected as Record<string, unknown>)) {
    for (const raw of Array.isArray(value) ? value : [value]) {
      const choice = parseChoice(raw);
      if (choice && known.has(choice.id) && !chosen.has(choice.id)) chosen.set(choice.id, choice.placement === 'WHOLE' ? null : choice.placement);
    }
  }
  return emitResolved(groups, chosen);
}

/** Per-unit price the selected options add on top of the line's base price. */
export function optionsUnitPrice(options: ResolvedOption[]): number {
  return options.reduce((sum, o) => sum + o.additionalPrice, 0);
}

/** [MENU-OPTIONS] The line's base: the chosen size's price when the item has a price-setting group and a size is
 *  chosen, the item's own basePrice otherwise. */
export function lineBasePrice(itemBasePrice: unknown, options: readonly ResolvedOption[]): number {
  const size = options.find((o) => o.setsPrice);
  return size ? size.listedPrice : Number(itemBasePrice);
}

// ---------------------------------------------------------------------------
// [MENU-OPTIONS] Older apps. An item using a size that sets the price, halves or follow-up choices cannot be shown
// right by an app built before them (it would show "+$2500" on a size and every follow-up group as always open), so
// a cart write for such an item must come from an app that declares it can: otherwise a plain "update the app".
// ---------------------------------------------------------------------------

/** The capability an app declares on a cart write when it renders sizes, halves and follow-up choices. */
export const MENU_OPTIONS_CAPABILITY = 'MENU_OPTIONS_V2';

export const MENU_OPTIONS_APP_UPDATE_MESSAGE =
  'This item has choices this version of the Swift app cannot show (sizes, half-and-half or extra choices). Update the Swift app to order it.';

/** True when the item uses any rule an older app cannot render. */
export function itemNeedsMenuOptionsV2(item: { optionGroups?: ReadonlyArray<{ setsPrice?: boolean | null; allowHalves?: boolean | null; options: ReadonlyArray<{ followUpGroupId?: string | null }> }> | null }): boolean {
  return (item.optionGroups ?? []).some((g) => g.setsPrice === true || g.allowHalves === true || g.options.some((o) => !!o.followUpGroupId));
}

/** Whether a request body declares the capability. */
export function declaresMenuOptionsV2(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes(MENU_OPTIONS_CAPABILITY);
}

// ---------------------------------------------------------------------------
// [L09 · M023] ONE validator for a selection, used by cart add, cart update
// and checkout. Pricing above only ever sees a selection this accepted.
// ---------------------------------------------------------------------------

export type OptionSelectionReason =
  | 'OPTION_UNKNOWN' | 'OPTION_UNAVAILABLE' | 'OPTION_DUPLICATE' | 'OPTION_LIMIT' | 'OPTION_REQUIRED'
  /** [MENU-OPTIONS] a half placement in a group that does not allow halves */
  | 'OPTION_PLACEMENT'
  /** [MENU-OPTIONS] a follow-up choice without the option that opens it */
  | 'OPTION_FOLLOW_UP';

export class OptionSelectionError extends Error {
  constructor(
    readonly reason: OptionSelectionReason,
    readonly groupName: string | null,
    message: string,
    /** The choice that was refused, when one was named (a sold-out choice). */
    readonly optionName: string | null = null,
  ) {
    super(message);
    this.name = 'OptionSelectionError';
  }
}

type ValidatableOption = { id: string; name: string; additionalPrice: unknown; isAvailable?: boolean | null; followUpGroupId?: string | null; sortOrder?: number | null };
export type ValidatableGroup = {
  id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: ValidatableOption[];
  sortOrder?: number | null; setsPrice?: boolean | null; allowHalves?: boolean | null; halfPricePercent?: number | null;
};

export type OptionSelection = Record<string, string | string[]>;

/**
 * Accepts `{ [optionGroupId]: choice | choice[] }` only when every key is one of the item's groups, every id is a
 * live option of THAT group, nothing repeats, a half placement is asked only where the group allows halves, no group
 * exceeds its maximum, every required group (and every partly-filled group with a minimum) is satisfied, a size is
 * chosen wherever a group sets the price, and a follow-up group is answered only while (and whenever required)
 * its opener is chosen. Returns the selection in canonical form (keys sorted, multi-choice values sorted, a whole
 * placement written as the bare id) and its priced options.
 */
export function validateSelectedOptions(
  item: { optionGroups?: ValidatableGroup[] | null },
  selected: unknown,
): { selection: OptionSelection; options: ResolvedOption[] } {
  const groups = item.optionGroups ?? [];
  if (selected != null && (typeof selected !== 'object' || Array.isArray(selected))) {
    throw new OptionSelectionError('OPTION_UNKNOWN', null, 'Those options are not valid for this item.');
  }
  const raw = (selected ?? {}) as Record<string, unknown>;
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const key of Object.keys(raw)) {
    if (!byId.has(key)) throw new OptionSelectionError('OPTION_UNKNOWN', null, 'That option is not available for this item.');
  }
  const followUps = followUpGroupIds(groups);
  const selection: OptionSelection = {};
  const chosen = new Map<string, Placement | null>();
  const openedGroups = new Set<string>();

  const judge = (group: ValidatableGroup, opened: boolean) => {
    const value = raw[group.id];
    const picks: unknown[] = value == null ? [] : Array.isArray(value) ? value : [value];
    const optionById = new Map(group.options.map((o) => [o.id, o]));
    const seen = new Map<string, Placement | null>();
    for (const pick of picks) {
      const choice = parseChoice(pick);
      const option = choice ? optionById.get(choice.id) : undefined;
      if (!choice || !option) throw new OptionSelectionError('OPTION_UNKNOWN', group.name, `That option isn't available for "${group.name}"`);
      // [F4] Sold out is enforced HERE, for every client (an older app, the
      // web, a stale menu): never only by a screen hiding the choice.
      if (option.isAvailable === false) {
        throw new OptionSelectionError('OPTION_UNAVAILABLE', group.name, `${option.name} is sold out right now. Choose another option for "${group.name}"`, option.name);
      }
      if (choice.placement && choice.placement !== 'WHOLE' && group.allowHalves !== true) {
        throw new OptionSelectionError('OPTION_PLACEMENT', group.name, `"${group.name}" can only go on the whole item`);
      }
      if (seen.has(option.id)) throw new OptionSelectionError('OPTION_DUPLICATE', group.name, `Choose each option for "${group.name}" once`);
      seen.set(option.id, choice.placement === 'WHOLE' ? null : choice.placement);
    }
    if (!opened) {
      if (seen.size > 0) throw new OptionSelectionError('OPTION_FOLLOW_UP', group.name, `"${group.name}" goes with a choice you have not picked`);
      return;
    }
    if (seen.size > group.maxSelect) {
      throw new OptionSelectionError('OPTION_LIMIT', group.name, `Choose at most ${group.maxSelect} for "${group.name}"`);
    }
    const required = group.isRequired || group.setsPrice === true;
    const minimum = required ? Math.max(1, group.minSelect) : seen.size > 0 ? group.minSelect : 0;
    if (seen.size < minimum) {
      throw new OptionSelectionError('OPTION_REQUIRED', group.name, `Please choose an option for "${group.name}"`);
    }
    if (seen.size === 0) return;
    const canonical = [...seen].map(([id, placement]) => canonicalChoice(id, placement));
    selection[group.id] = Array.isArray(value) ? [...canonical].sort() : canonical[0]!;
    for (const [id, placement] of seen) {
      chosen.set(id, placement);
      const opens = optionById.get(id)!.followUpGroupId;
      if (opens && followUps.has(opens) && !followUps.has(group.id)) openedGroups.add(opens);
    }
  };
  // Top-level groups first (they decide which follow-up groups are open), then the follow-up groups.
  for (const group of groups) if (!followUps.has(group.id)) judge(group, true);
  for (const group of groups) if (followUps.has(group.id)) judge(group, openedGroups.has(group.id));

  const canonicalSelection: OptionSelection = {};
  for (const key of Object.keys(selection).sort()) canonicalSelection[key] = selection[key]!;
  return { selection: canonicalSelection, options: emitResolved(groups, chosen) };
}

/** A selection's identity, independent of key order and multi-choice order. */
export function selectionKey(selected: unknown): string {
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return '{}';
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(selected as Record<string, unknown>).sort()) {
    const value = (selected as Record<string, unknown>)[key];
    out[key] = Array.isArray(value) ? [...value].map(String).sort() : value;
  }
  return JSON.stringify(out);
}

/** An item note as a cart line carries it: trimmed, and empty means none. */
export function normalizeItemNote(note: string | null | undefined): string | null {
  const trimmed = (note ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * [L09 · reorder] A past line's choices, rebuilt against TODAY's menu from the
 * group and option names its order kept (an order stores names, not ids).
 * Returns the canonical selection only when it can be rebuilt exactly and the
 * one validator accepts it; null when a choice is gone, sold out, renamed or
 * ambiguous, or the item now needs a choice the order never made. A reorder
 * never drops a choice silently and never guesses one.
 */
export function rebuildSelectionFromSnapshot(
  item: { optionGroups?: ValidatableGroup[] | null },
  snapshot: ReadonlyArray<{
    optionGroupName: string; optionName: string;
    /** [MENU-OPTIONS] The parts (null on a row written before them: the display words are then the plain names). */
    plainGroupName?: string | null; plainOptionName?: string | null; placement?: string | null; parentOptionName?: string | null;
  }>,
): OptionSelection | null {
  const groups = item.optionGroups ?? [];
  const followUps = followUpGroupIds(groups);
  const chosen = new Map<string, string[]>();
  for (const pick of snapshot) {
    const groupName = pick.plainGroupName ?? pick.optionGroupName;
    const optionName = pick.plainOptionName ?? pick.optionName;
    // A follow-up choice is looked for only among the groups its opener opens; a top-level one only among the rest.
    const candidates = pick.parentOptionName
      ? groups.filter((g) => followUps.has(g.id) && groups.some((p) => p.options.some((o) => o.name === pick.parentOptionName && o.followUpGroupId === g.id)))
      : groups.filter((g) => !followUps.has(g.id));
    const matchingGroups = candidates.filter((g) => g.name === groupName);
    if (matchingGroups.length !== 1) return null;
    const group = matchingGroups[0]!;
    const matchingOptions = group.options.filter((o) => o.name === optionName);
    if (matchingOptions.length !== 1) return null;
    const placement = pick.placement === 'LEFT' || pick.placement === 'RIGHT' ? pick.placement : null;
    chosen.set(group.id, [...(chosen.get(group.id) ?? []), canonicalChoice(matchingOptions[0]!.id, placement)]);
  }
  const shaped: Record<string, string | string[]> = {};
  for (const group of groups) {
    const ids = chosen.get(group.id);
    if (!ids) continue;
    // The shape the apps send: one id for a pick-one group, a list otherwise.
    shaped[group.id] = group.maxSelect > 1 || ids.length > 1 ? ids : ids[0]!;
  }
  try {
    return validateSelectedOptions(item, shaped).selection;
  } catch (error) {
    if (error instanceof OptionSelectionError) return null;
    throw error;
  }
}

/**
 * [F4] Why a cart line cannot be ordered as it stands, in a few plain words
 * for the cart screen, or null when its choices are still good. The cart
 * quote marks such a line unavailable, the same as a sold-out item, so every
 * app blocks the order button on it and offers Remove.
 */
export function lineOptionsIssue(item: { optionGroups?: ValidatableGroup[] | null }, selected: unknown): string | null {
  try {
    validateSelectedOptions(item, selected);
    return null;
  } catch (error) {
    if (!(error instanceof OptionSelectionError)) throw error;
    if (error.reason === 'OPTION_UNAVAILABLE' && error.optionName) return `${error.optionName} is sold out — remove and choose again`;
    if (error.reason === 'OPTION_UNKNOWN') return 'A choice is no longer on the menu — remove and choose again';
    return 'Your choices need updating — remove and choose again';
  }
}
