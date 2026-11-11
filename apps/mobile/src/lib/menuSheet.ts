/**
 * [MENU-OPTIONS · owner 11 Nov 2026] The customer item sheet's choices, the same on the phone and the website.
 *
 * Like a pizza shop's sheet: a SIZE group (setsPrice) is pick-one and its choice IS the item price; a HALF-AND-HALF
 * group puts each topping on the whole item, the left half or the right half; an option may OPEN a follow-up group
 * (one level deep), shown right under it only while it is chosen, whose choices go when it is unchosen.
 *
 * This module decides what the sheet shows and what a tap does to the selection. It prices nothing: each app prices
 * with the server's own rules (the website imports apps/api/src/modules/order/options.ts by path; the phone runs
 * menuOptionsEngine.ts, pinned to that file). It imports nothing, so the website can import it by path
 * (apps/web/Dockerfile copies this one file; apps/web/src/image-build-context.test.ts keeps the two in step).
 *
 * A selection is `{ [groupId]: choice[] }`, a choice being what the API reads: `<optionId>` (the whole item, or a
 * group without halves), `<optionId>:left` or `<optionId>:right`.
 */

export type Placement = 'WHOLE' | 'LEFT' | 'RIGHT';

export type SheetOption = {
  id: string;
  name: string;
  additionalPrice?: unknown;
  isDefault?: boolean | null;
  isAvailable?: boolean | null;
  sortOrder?: number | null;
  followUpGroupId?: string | null;
};

export type SheetGroup = {
  id: string;
  name: string;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  sortOrder?: number | null;
  setsPrice?: boolean | null;
  allowHalves?: boolean | null;
  halfPricePercent?: number | null;
  options: SheetOption[];
};

/** The sheet's choices: group id -> the choices as the API reads them. */
export type SheetSelection = Record<string, string[]>;

/** [MENU-OPTIONS] What every cart write declares: this app shows sizes that set the price, halves and follow-up
 *  choices (the API refuses such an item from an app that does not say so: 409 APP_UPDATE_REQUIRED). */
export const MENU_OPTIONS_CAPABILITY = 'MENU_OPTIONS_V2';

/** A fresh list for a request body. */
export function cartWriteCapabilities(): string[] {
  return [MENU_OPTIONS_CAPABILITY];
}

const SUFFIX: Record<string, Placement> = { left: 'LEFT', right: 'RIGHT', whole: 'WHOLE' };

/** The option id a choice names. */
export function choiceId(choice: string): string {
  const at = choice.lastIndexOf(':');
  return at > 0 && SUFFIX[choice.slice(at + 1)] ? choice.slice(0, at) : choice;
}

/** Where a choice goes: the whole item unless it names a half. */
export function choicePlacement(choice: string): Placement {
  const at = choice.lastIndexOf(':');
  return (at > 0 && SUFFIX[choice.slice(at + 1)]) || 'WHOLE';
}

/** A choice as the API reads it: the bare id for the whole item, a suffix for a half. */
export function encodeChoice(optionId: string, placement: Placement): string {
  return placement === 'LEFT' ? `${optionId}:left` : placement === 'RIGHT' ? `${optionId}:right` : optionId;
}

/** A choice the store marked sold out is shown, never chosen. */
export const onSale = (option: { isAvailable?: boolean | null }): boolean => option.isAvailable !== false;

const byMenuOrder = <T extends { sortOrder?: number | null; id: string }>(a: T, b: T) =>
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The options of a group in menu order. */
export function sortedOptions(group: SheetGroup): SheetOption[] {
  return [...group.options].sort(byMenuOrder);
}

/** The groups some option of the item opens (the API's rule: a group of the same item, never the opener's own). */
export function followUpGroupIds(groups: readonly SheetGroup[]): Set<string> {
  const ids = new Set(groups.map((g) => g.id));
  const targets = new Set<string>();
  for (const g of groups) for (const o of g.options) if (o.followUpGroupId && ids.has(o.followUpGroupId) && o.followUpGroupId !== g.id) targets.add(o.followUpGroupId);
  return targets;
}

/** The groups the sheet lists at the top level, in menu order (follow-up groups are drawn under their opener). */
export function topLevelGroups(groups: readonly SheetGroup[]): SheetGroup[] {
  const followUps = followUpGroupIds(groups);
  return [...groups].filter((g) => !followUps.has(g.id)).sort(byMenuOrder);
}

/** The follow-up group this option opens, or null (an option inside a follow-up group never opens another). */
export function followUpFor(groups: readonly SheetGroup[], group: SheetGroup, option: SheetOption): SheetGroup | null {
  if (!option.followUpGroupId) return null;
  const followUps = followUpGroupIds(groups);
  if (followUps.has(group.id) || !followUps.has(option.followUpGroupId)) return null;
  return groups.find((g) => g.id === option.followUpGroupId) ?? null;
}

/** A pick-one group (radio): one choice at most. */
export const singleChoice = (group: SheetGroup): boolean => group.setsPrice === true || group.maxSelect <= 1;

/** The group must be answered (a size always must: the API requires it even when the store left it optional). */
export const requiredGroup = (group: SheetGroup): boolean => group.isRequired || group.setsPrice === true;

/** A pick-one group whose choice can be taken back with a second tap (nothing requires it). */
export const clearableSingle = (group: SheetGroup): boolean => singleChoice(group) && !requiredGroup(group) && group.minSelect <= 0;

/** The most choices the group takes. */
export const maxChoices = (group: SheetGroup): number => (singleChoice(group) ? 1 : group.maxSelect);

/** The words under a group's name: "Choose 1", "Choose 2", "Choose 1–3", "Choose up to 3". */
export function groupGuidance(group: SheetGroup): string {
  const max = maxChoices(group);
  const min = requiredGroup(group) ? Math.max(1, group.minSelect) : group.minSelect;
  if (max <= 1) return min > 0 ? 'Choose 1' : 'Choose up to 1';
  if (min >= max) return `Choose ${max}`;
  if (min > 0) return `Choose ${min}–${max}`;
  return `Choose up to ${max}`;
}

/** The choices made in a group (an absent group has none). */
export function groupChoices(selection: SheetSelection, groupId: string): string[] {
  return selection[groupId] ?? [];
}

/** Whether this option is chosen in this group (on any half). */
export function isChosen(selection: SheetSelection, groupId: string, optionId: string): boolean {
  return groupChoices(selection, groupId).some((choice) => choiceId(choice) === optionId);
}

/** Where a chosen option goes, or null when it is not chosen. */
export function placementOf(selection: SheetSelection, groupId: string, optionId: string): Placement | null {
  const choice = groupChoices(selection, groupId).find((c) => choiceId(c) === optionId);
  return choice === undefined ? null : choicePlacement(choice);
}

/** The follow-up groups the chosen options open now (top-level openers only, as the API reads them). */
export function openedFollowUps(groups: readonly SheetGroup[], selection: SheetSelection): Set<string> {
  const opened = new Set<string>();
  for (const group of topLevelGroups(groups)) {
    for (const option of group.options) {
      if (isChosen(selection, group.id, option.id) && followUpFor(groups, group, option)) opened.add(option.followUpGroupId!);
    }
  }
  return opened;
}

/** The store's pre-selected choices of one group that are on sale, at most as many as it takes. */
function groupDefaults(group: SheetGroup): string[] {
  return sortedOptions(group).filter((o) => o.isDefault === true && onSale(o)).slice(0, maxChoices(group)).map((o) => o.id);
}

/**
 * Keeps a selection in step with what is open: a follow-up group that nothing opens loses its choices; one that has
 * just opened gets the store's pre-selected choices; an emptied group is dropped.
 */
function settle(groups: readonly SheetGroup[], selection: SheetSelection, openBefore: ReadonlySet<string>): SheetSelection {
  const followUps = followUpGroupIds(groups);
  const open = openedFollowUps(groups, selection);
  const next: SheetSelection = {};
  for (const [groupId, choices] of Object.entries(selection)) {
    if (followUps.has(groupId) && !open.has(groupId)) continue;
    if (choices.length > 0) next[groupId] = choices;
  }
  for (const groupId of open) {
    if (openBefore.has(groupId) || next[groupId]) continue;
    const group = groups.find((g) => g.id === groupId);
    const defaults = group ? groupDefaults(group) : [];
    if (defaults.length) next[groupId] = defaults;
  }
  return next;
}

/** The sheet as it opens: the store's pre-selected choices (never a sold-out one), and those of what they open. */
export function defaultSelection(groups: readonly SheetGroup[] | null | undefined): SheetSelection {
  const all = groups ?? [];
  const start: SheetSelection = {};
  for (const group of topLevelGroups(all)) {
    const defaults = groupDefaults(group);
    if (defaults.length) start[group.id] = defaults;
  }
  return settle(all, start, new Set());
}

/**
 * A tap on an option. Pick-one: the option replaces the group's choice (a second tap takes it back only where
 * nothing requires the group). Pick-many: on or off, never past the group's maximum. A sold-out option, a group of
 * another item, or a follow-up group that is not open changes nothing. A new choice goes on the whole item.
 */
export function chooseOption(groups: readonly SheetGroup[], selection: SheetSelection, groupId: string, optionId: string): SheetSelection {
  const group = groups.find((g) => g.id === groupId);
  const option = group?.options.find((o) => o.id === optionId);
  if (!group || !option || !onSale(option)) return selection;
  const openBefore = openedFollowUps(groups, selection);
  if (followUpGroupIds(groups).has(groupId) && !openBefore.has(groupId)) return selection;
  const current = groupChoices(selection, groupId);
  const chosen = isChosen(selection, groupId, optionId);
  let choices: string[];
  if (singleChoice(group)) {
    if (chosen) {
      if (!clearableSingle(group)) return selection;
      choices = [];
    } else {
      choices = [optionId];
    }
  } else if (chosen) {
    choices = current.filter((c) => choiceId(c) !== optionId);
  } else {
    if (current.length >= group.maxSelect) return selection;
    choices = [...current, optionId];
  }
  return settle(groups, { ...selection, [groupId]: choices }, openBefore);
}

/** Moves a chosen option of a half-and-half group to the whole item, the left half or the right half. */
export function placeOption(groups: readonly SheetGroup[], selection: SheetSelection, groupId: string, optionId: string, placement: Placement): SheetSelection {
  const group = groups.find((g) => g.id === groupId);
  if (!group || group.allowHalves !== true || !isChosen(selection, groupId, optionId)) return selection;
  return {
    ...selection,
    [groupId]: groupChoices(selection, groupId).map((c) => (choiceId(c) === optionId ? encodeChoice(optionId, placement) : c)),
  };
}

/**
 * A selection kept from before (sign-in, a saved draft), against today's menu: only choices still on sale in their
 * group, a half only where the group allows halves, at most as many as the group takes, follow-ups only while open.
 * Anything else is dropped (the customer sees what is left and chooses again; nothing is guessed).
 */
export function restoreSelection(groups: readonly SheetGroup[] | null | undefined, raw: unknown): SheetSelection {
  const all = groups ?? [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const kept: SheetSelection = {};
  for (const group of all) {
    const value = (raw as Record<string, unknown>)[group.id];
    const picks = (Array.isArray(value) ? value : value == null ? [] : [value]).filter((v): v is string => typeof v === 'string');
    const seen = new Set<string>();
    const choices: string[] = [];
    for (const pick of picks) {
      const id = choiceId(pick);
      const option = group.options.find((o) => o.id === id);
      if (!option || !onSale(option) || seen.has(id)) continue;
      const placement = choicePlacement(pick);
      if (placement !== 'WHOLE' && group.allowHalves !== true) continue;
      seen.add(id);
      choices.push(encodeChoice(id, placement));
    }
    if (choices.length) kept[group.id] = choices.slice(0, maxChoices(group));
  }
  const open = openedFollowUps(all, kept);
  return settle(all, kept, open);
}

/** A selection as the cart or a saved draft holds it (`choice | choice[]` per group), in the sheet's shape. Nothing
 *  is judged here: the server's validator judges it before an Add. */
export function asSheetSelection(raw: unknown): SheetSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: SheetSelection = {};
  for (const [groupId, value] of Object.entries(raw as Record<string, unknown>)) {
    const choices = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (choices.length) out[groupId] = choices;
  }
  return out;
}

/** The selection as the cart is sent it: a pick-one group as one choice, any other as a list; empty groups left out. */
export function wireSelection(groups: readonly SheetGroup[] | null | undefined, selection: SheetSelection): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [groupId, choices] of Object.entries(selection)) {
    if (!choices.length) continue;
    const group = (groups ?? []).find((g) => g.id === groupId);
    out[groupId] = group && singleChoice(group) && choices.length === 1 ? choices[0]! : choices;
  }
  return out;
}

/** The item has sizes that set its price: its listed price is the smallest size's, a "From" price. */
export function hasSizes(item: { optionGroups?: ReadonlyArray<{ setsPrice?: boolean | null }> | null } | null | undefined): boolean {
  return (item?.optionGroups ?? []).some((g) => g.setsPrice === true);
}

/** A size is chosen in this selection. */
export function sizeChosen(groups: readonly SheetGroup[] | null | undefined, selection: SheetSelection): boolean {
  return (groups ?? []).some((g) => g.setsPrice === true && groupChoices(selection, g.id).length > 0);
}

// ---------------------------------------------------------------------------
// An order line's choices, as the customer reads them back (order detail).
// ---------------------------------------------------------------------------

/** One chosen option of an order line, as the API sends it (older rows have only group / name). */
export type OrderLineChoice = {
  group?: string | null;
  name?: string | null;
  plainGroup?: string | null;
  plainName?: string | null;
  placement?: string | null;
  parentOptionName?: string | null;
  setsPrice?: boolean | null;
};

/** One line of the read-back: a group's choices, and whether it is a follow-up drawn under its opener. */
export type ChoiceLine = { text: string; followUp: boolean };

const PLACEMENT_WORD: Record<Placement, string> = { WHOLE: 'Whole', LEFT: 'Left', RIGHT: 'Right' };

/**
 * "Size: Large", "Crust: Stuffed crust", under it "Cheese: Cheddar" (a follow-up), and a half-and-half group laid out
 * as "Toppings — Whole: Onion / Left: Pepperoni / Right: Mushroom". The API sends the choices in menu order with each
 * follow-up right after its opener. A row without the parts (an older order) reads "group: name".
 */
export function orderLineChoices(options: readonly OrderLineChoice[] | null | undefined): ChoiceLine[] {
  type Bucket = { group: string; followUp: boolean; picks: Array<{ name: string; placement: Placement | null }> };
  const buckets: Bucket[] = [];
  const byKey = new Map<string, Bucket>();
  for (const o of options ?? []) {
    const name = (o?.plainName ?? o?.name ?? '').trim();
    if (!name) continue;
    const group = (o.plainGroup ?? o.group ?? '').trim();
    const parent = o.parentOptionName ?? null;
    const placement = o.placement === 'WHOLE' || o.placement === 'LEFT' || o.placement === 'RIGHT' ? o.placement : null;
    const key = `${parent ?? ''}\u0000${group}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { group, followUp: parent !== null, picks: [] };
      byKey.set(key, bucket);
      buckets.push(bucket);
    }
    bucket.picks.push({ name, placement });
  }
  return buckets.map((bucket) => {
    const halves = bucket.picks.some((p) => p.placement === 'LEFT' || p.placement === 'RIGHT');
    let body: string;
    if (halves) {
      body = (['WHOLE', 'LEFT', 'RIGHT'] as const)
        .map((at) => [at, bucket.picks.filter((p) => (p.placement ?? 'WHOLE') === at).map((p) => p.name)] as const)
        .filter(([, names]) => names.length > 0)
        .map(([at, names]) => `${PLACEMENT_WORD[at]}: ${names.join(', ')}`)
        .join(' / ');
      return { text: bucket.group ? `${bucket.group} — ${body}` : body, followUp: bucket.followUp };
    }
    body = bucket.picks.map((p) => p.name).join(', ');
    return { text: bucket.group ? `${bucket.group}: ${body}` : body, followUp: bucket.followUp };
  });
}
