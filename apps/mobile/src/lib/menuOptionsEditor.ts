/**
 * [MENU-OPTIONS · owner 11 Nov 2026] The store tools' rules for pizza-grade options, in the app's words:
 *   - SIZE SETS THE PRICE: a group that sets the price is pick exactly one; each choice's price is the item's whole
 *     price ("Price", not "+"), and the item's own price is the lowest size (the server keeps it so: read-only here).
 *   - HALF-AND-HALF: each choice on the whole item, the left or the right half; a half costs the store's percent of
 *     the choice's price (100 = full price).
 *   - NESTED, one level: a choice may open one follow-up group of the same item; a follow-up group's choices open
 *     nothing.
 *   - THE SHARED LIBRARY: a group built once and attached to many items; editing it changes every item that uses it.
 * The server is the only judge (400 MENU_OPTIONS_RULE / 409 SHARED_OPTION_GROUP, shown in its own words); these rules
 * only keep the tools from offering what it would refuse.
 *
 * Import-free: the website's store tools import this file as is (the website copies the app).
 */

type GroupLike = {
  id?: string;
  name?: string;
  isRequired?: boolean | null;
  maxSelect?: number | null;
  setsPrice?: boolean | null;
  allowHalves?: boolean | null;
  halfPricePercent?: number | null;
  libraryGroupId?: string | null;
  options?: ReadonlyArray<{ id?: string; name?: string; followUpGroupId?: string | null; additionalPrice?: unknown; vatListedAdditionalPrice?: unknown; price?: unknown }> | null;
};

export type GroupFlags = { required: boolean; multi: boolean; setsPrice: boolean; allowHalves: boolean; halfPercent: number };
export type GroupFlagsBody = {
  isRequired: boolean; minSelect: number; maxSelect: number;
  setsPrice?: boolean; allowHalves?: boolean; halfPricePercent?: number;
};

/** "Multiple picks" lets the customer pick up to this many. */
export const MULTI_PICK_MAX = 10;

/** A whole percent from 1 to 100, or null. */
export function parseHalfPercent(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 100 ? n : null;
}

const safePercent = (n: number) => (Number.isInteger(n) && n >= 1 && n <= 100 ? n : 100);

/** The group's rules as the server takes them. A group that sets the price is pick exactly one and never
 *  half-and-half. A new group sends a flag only when it is on (a plain group's request is what it always was); an edit
 *  (`explicit`) names every flag, so switching one off reaches the server. */
export function groupFlagsBody(f: GroupFlags, { explicit = false }: { explicit?: boolean } = {}): GroupFlagsBody {
  if (f.setsPrice) {
    return { isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: true, ...(explicit ? { allowHalves: false } : {}) };
  }
  const base: GroupFlagsBody = { isRequired: f.required, minSelect: f.required ? 1 : 0, maxSelect: f.multi ? MULTI_PICK_MAX : 1 };
  if (explicit) return { ...base, setsPrice: false, allowHalves: f.allowHalves, halfPricePercent: f.allowHalves ? safePercent(f.halfPercent) : 100 };
  return f.allowHalves ? { ...base, allowHalves: true, halfPricePercent: safePercent(f.halfPercent) } : base;
}

/** The flags of a saved group, for its edit controls. */
export function flagsOf(g: GroupLike): GroupFlags {
  return {
    required: g.isRequired === true,
    multi: (g.maxSelect ?? 1) > 1,
    setsPrice: g.setsPrice === true,
    allowHalves: g.allowHalves === true,
    halfPercent: safePercent(g.halfPricePercent ?? 100),
  };
}

/** The half price rule as the store picks it. */
export function halfRuleWords(percent: number): string {
  return safePercent(percent) === 100 ? 'Full price' : `${safePercent(percent)}% of the choice price`;
}

/** The caption under a group: what the customer does. */
export function groupRuleWords(g: GroupLike): string {
  if (g.setsPrice) return 'Sets the price · pick one';
  const max = g.maxSelect ?? 1;
  const base = `${g.isRequired ? 'Required' : 'Optional'} · ${max > 1 ? `up to ${max}` : 'pick one'}`;
  if (!g.allowHalves) return base;
  const pct = safePercent(g.halfPricePercent ?? 100);
  return `${base} · Half-and-half (a half costs ${pct === 100 ? 'full price' : `${pct}% of the choice price`})`;
}

/** The price a store TYPED for a choice (before VAT while VAT is added). */
const typedPrice = (o: { additionalPrice?: unknown; vatListedAdditionalPrice?: unknown; price?: unknown }) =>
  Number(o.vatListedAdditionalPrice ?? o.additionalPrice ?? o.price);

/** A size choice's price: the item's whole price. */
export function sizePriceLabel(o: { additionalPrice?: unknown; vatListedAdditionalPrice?: unknown; price?: unknown }, money: (_n: number) => string): string {
  const n = Number(o.additionalPrice ?? o.price);
  return `Price ${money(Number.isFinite(n) ? n : 0)}${o.vatListedAdditionalPrice != null ? ' incl. VAT' : ''}`;
}

/** The price box of a new choice. */
export function choicePricePlaceholder(setsPrice: boolean, vatAdded: boolean): string {
  if (setsPrice) return vatAdded ? 'Price before VAT' : 'Price';
  return vatAdded ? '+GYD before VAT' : '+GYD';
}

/** The item's "from" price: its lowest size, as typed (the server keeps the item's price so). null without sizes. */
export function lowestSizePrice(groups: readonly GroupLike[] | null | undefined): number | null {
  const sized = (groups ?? []).find((g) => g.setsPrice);
  const prices = (sized?.options ?? []).map(typedPrice).filter((n) => Number.isFinite(n));
  return prices.length ? Math.min(...prices) : null;
}

export function fromPriceWords(n: number, money: (_n: number) => string): string {
  return `From ${money(n)} (lowest size)`;
}

/** Whether some choice of the item opens this group (it is a follow-up group). */
export function isFollowUpGroup(groups: readonly GroupLike[], groupId: string | undefined): boolean {
  if (!groupId) return false;
  return groups.some((g) => g.id !== groupId && (g.options ?? []).some((o) => o.followUpGroupId === groupId));
}

/** The groups a choice of `groupId` may open: another group of the item that does not set the price and opens
 *  nothing itself. A follow-up group's own choices open nothing (one level only). */
export function followUpTargets<G extends GroupLike>(groups: readonly G[], groupId: string | undefined): G[] {
  if (!groupId || isFollowUpGroup(groups, groupId)) return [];
  return groups.filter((g) => g.id && g.id !== groupId && !g.setsPrice && !(g.options ?? []).some((o) => o.followUpGroupId));
}

/** The follow-up picker's label. */
export function followUpLabel(groups: readonly GroupLike[], followUpGroupId: string | null | undefined): string {
  const target = followUpGroupId ? groups.find((g) => g.id === followUpGroupId) : undefined;
  return target?.name ? `Opens: ${target.name}` : 'Opens follow-up group';
}

// ── The shared library ──────────────────────────────────────────────────────

type LibraryLike = { id: string; usedByItemCount?: number | null; isFollowUp?: boolean | null };

/** An item's copy of a shared group: which library group, and how many items use it. null for the item's own group. */
export function sharedUse(group: { libraryGroupId?: string | null }, library: readonly LibraryLike[] | null | undefined): { libraryGroupId: string; usedBy: number } | null {
  if (!group.libraryGroupId) return null;
  const found = (library ?? []).find((l) => l.id === group.libraryGroupId);
  return { libraryGroupId: group.libraryGroupId, usedBy: Math.max(1, found?.usedByItemCount ?? 1) };
}

const items = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

export function usedByWords(n: number): string {
  return `Used by ${items(n)}`;
}

export function sharedEditWarning(n: number): string {
  return n === 1 ? 'Changes apply to the 1 item that uses it' : `Changes apply to all ${items(n)}`;
}

export function libraryDeleteWords(n: number): string {
  if (n <= 0) return 'No item uses it.';
  return `It is removed from ${items(n)} that ${n === 1 ? 'uses' : 'use'} it.`;
}

/** "Add from option library": the groups not on the item yet. A follow-up group comes with the choice that opens it. */
export function libraryGroupsToAdd<L extends LibraryLike>(library: readonly L[] | null | undefined, itemGroups: ReadonlyArray<{ libraryGroupId?: string | null }>): L[] {
  const on = new Set(itemGroups.map((g) => g.libraryGroupId).filter((id): id is string => !!id));
  return (library ?? []).filter((l) => !on.has(l.id) && !l.isFollowUp);
}

/** Bulk attach / detach: only the change is sent. */
export function attachPlan(current: readonly string[], chosen: readonly string[]): { attach: string[]; detach: string[] } {
  const was = new Set(current);
  const now = new Set(chosen);
  return { attach: chosen.filter((id) => !was.has(id)), detach: current.filter((id) => !now.has(id)) };
}

/** One entry moved up (-1) or down (+1); unchanged at the ends. */
export function moved<T>(list: readonly T[], index: number, step: -1 | 1): T[] {
  const to = index + step;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

// ── The server's refusal ────────────────────────────────────────────────────

const OWN_WORDS = new Set(['MENU_OPTIONS_RULE', 'SHARED_OPTION_GROUP']);

/** A broken option rule, or an edit of a shared copy: the server's own words (the phone's axios error, or the
 *  website's error with `code` and `message`). Anything else: null (the caller keeps its own sentence). */
export function menuOptionsRefusal(error: unknown): string | null {
  const e = error as { code?: unknown; message?: unknown; response?: { data?: { error?: { code?: unknown; message?: unknown } } } } | null;
  const body = e?.response?.data?.error ?? e;
  if (!body || typeof body.code !== 'string' || !OWN_WORDS.has(body.code)) return null;
  return typeof body.message === 'string' && body.message.trim() ? body.message : null;
}
