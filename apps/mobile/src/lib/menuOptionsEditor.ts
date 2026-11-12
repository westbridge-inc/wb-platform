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
  minSelect?: number | null;
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
export function sizePriceLabel(o: { additionalPrice?: unknown; vatListedAdditionalPrice?: unknown; price?: unknown }, format: (_n: number) => string): string {
  const n = Number(o.additionalPrice ?? o.price);
  return `Price ${format(Number.isFinite(n) ? n : 0)}${o.vatListedAdditionalPrice != null ? ' incl. VAT' : ''}`;
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

export function fromPriceWords(n: number, format: (_n: number) => string): string {
  return `From ${format(n)} (lowest size)`;
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

/** [REVIEW-MENU-B S3-4] Deleting a shared choice asks first: it leaves every item that uses its group. */
export function libraryChoiceDeleteWords(name: string, n: number): { title: string; body: string } {
  const body = n <= 0 ? 'No item uses this group yet.'
    : n === 1 ? 'It is removed from the 1 item that uses this group.' : `It is removed from ${items(n)} that use this group.`;
  return { title: `Remove “${name}”?`, body };
}

// ── [REVIEW-MENU-B S3-3] A typed price ──────────────────────────────────────

export const PRICE_UNREADABLE = 'Type the price in whole dollars, like 1500.';
export const SIZE_PRICE_NEEDED = 'Type this size’s full price (more than 0).';

/**
 * A price as a store types it, on a phone or a desktop keyboard: whole dollars, with or without thousands commas or
 * spaces, a "$" or "GYD" in front, ".00" after ("1,500", "1500.00", "$1,500" → 1500). A blank, a mistype, a negative or
 * cents give null: never a guessed price (a "1,500" read as 0 once made a $0 pizza).
 */
export function parseStorePrice(text: string): number | null {
  let t = text.trim().replace(/^(?:\$|GYD)\s*/i, '').replace(/[\s\u00a0]+/g, '');
  if (!t) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(t)) return null;
  t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** A choice's typed price, or the plain reason it cannot be saved: a size needs its full price above 0 (a blank size
 *  is never a $0 pizza); an add-on left blank is free ("+GYD", as the tools always took it), and a mistype is refused. */
export function choicePriceInput(text: string, { size }: { size: boolean }): { price: number } | { problem: string } {
  if (!size && text.trim() === '') return { price: 0 };
  const n = parseStorePrice(text);
  if (size) return n != null && n > 0 ? { price: n } : { problem: SIZE_PRICE_NEEDED };
  return n != null ? { price: n } : { problem: PRICE_UNREADABLE };
}

// ── [REVIEW-MENU-B S2-1] Switching "Sets the price" on a group with choices ─

type PricedChoice = { id: string; name: string; additionalPrice?: unknown; vatListedAdditionalPrice?: unknown; price?: unknown };
/** A converted price; null = not known (the store types it: never a guessed figure). */
export type SizeSwitchRow = { id: string; name: string; price: number | null };

/** The item's price as the store typed it (before VAT while VAT is added); null when unreadable. */
export function itemTypedPrice(item: { basePrice?: unknown; vatListedPrice?: unknown }): number | null {
  const raw = item.vatListedPrice ?? item.basePrice;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** A shared group's items can cost different amounts: its sizes start from the lowest of them (null when no price is
 *  known: the store types each size). */
export function libraryBasePrice(items: ReadonlyArray<{ basePrice?: unknown; vatListedPrice?: unknown }>): number | null {
  const prices = items.map(itemTypedPrice).filter((n): n is number => n != null);
  return prices.length ? Math.min(...prices) : null;
}

/** Whether a rule change switches "Sets the price" on a group that has choices: their prices mean something else after
 *  it (an add-on becomes a whole price, or back), so the store sees and confirms the converted prices first. */
export function needsSizeSwitchConfirm(group: { setsPrice?: boolean | null; options?: readonly unknown[] | null }, next: Partial<GroupFlags>): boolean {
  return next.setsPrice !== undefined && next.setsPrice !== (group.setsPrice === true) && (group.options ?? []).length > 0;
}

/**
 * The converted prices. ON: each size's full price = the item's price + the choice's add-on (Small +0 / Large +500 on a
 * 2,000 item → 2,000 / 2,500); with no known item price, each size is left for the store to type. OFF: each add-on = its
 * price above the smallest size (the item keeps the smallest as its price). Every figure is what the store typed (before
 * VAT while VAT is added).
 */
export function sizeSwitchRows(options: readonly PricedChoice[], { turnOn, itemPrice }: { turnOn: boolean; itemPrice: number | null }): SizeSwitchRow[] {
  const typed = options.map((o) => ({ id: o.id, name: o.name, price: typedPrice(o) }));
  if (turnOn) {
    return typed.map((o) => ({ ...o, price: itemPrice != null && Number.isFinite(itemPrice) ? itemPrice + (Number.isFinite(o.price) ? o.price : 0) : null }));
  }
  const known = typed.map((o) => o.price).filter((n) => Number.isFinite(n));
  const lowest = known.length ? Math.min(...known) : null;
  return typed.map((o) => ({ ...o, price: Number.isFinite(o.price) && lowest != null ? o.price - lowest : null }));
}

/** The confirm's editable boxes, prefilled with the converted prices (a price not known starts blank). */
export function sizeSwitchTyped(rows: readonly SizeSwitchRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r.id, r.price == null ? '' : String(r.price)]));
}

/** The prices as the store has them typed in the confirm (for its sentence). */
export function sizeSwitchShown(options: ReadonlyArray<{ id: string; name: string }>, typed: Readonly<Record<string, string>>): SizeSwitchRow[] {
  return options.map((o) => ({ id: o.id, name: o.name, price: parseStorePrice(typed[o.id] ?? '') }));
}

/** The confirm's sentence. */
export function sizeSwitchWords(rows: readonly SizeSwitchRow[], { turnOn, sharedBy }: { turnOn: boolean; sharedBy?: number }, format: (_n: number) => string): string {
  const list = rows.map((r) => `${r.name} ${r.price == null ? '(type its price)' : `${turnOn ? '' : '+'}${format(r.price)}`}`).join(' / ');
  const who = sharedBy != null ? `every item that uses this group (${items(sharedBy)})` : 'the item';
  if (turnOn) return sharedBy != null ? `${list} — ${who} costs these sizes’ prices.` : `${list} — the item’s price becomes its sizes’ prices.`;
  return `${list} — ${who} keeps its smallest size as its price; these are added on top.`;
}

/** The one request of a confirmed switch: the switch and every choice's new typed price, each read like any typed price
 *  (a size above 0; an add-on left blank is free, a mistyped one refused). */
export function sizeSwitchBody(options: ReadonlyArray<{ id: string; name: string }>, typed: Readonly<Record<string, string>>, { turnOn }: { turnOn: boolean }):
  { body: { setsPrice: boolean; prices: Array<{ id: string; price: number }> } } | { problem: string } {
  const prices: Array<{ id: string; price: number }> = [];
  for (const o of options) {
    const read = choicePriceInput(typed[o.id] ?? '', { size: turnOn });
    if ('problem' in read) return { problem: `${o.name}: ${read.problem}` };
    prices.push({ id: o.id, price: read.price });
  }
  return { body: { setsPrice: turnOn, prices } };
}

// ── [REVIEW-MENU-B S3-2] An edit of a saved group sends only what changed ───

export type GroupFlagsEditBody = Partial<{ isRequired: boolean; minSelect: number; maxSelect: number; setsPrice: boolean; allowHalves: boolean; halfPricePercent: number }>;

/** The edit of a saved group: only the rules the store changed. A rule chip never rewrites the group's own limits
 *  (a "up to 3" group stays up to 3); Required / Multiple picks change them only when tapped; a size is made pick-one by
 *  the server itself. */
export function groupFlagsEdit(
  saved: { isRequired?: boolean | null; minSelect?: number | null; maxSelect?: number | null; setsPrice?: boolean | null; allowHalves?: boolean | null; halfPricePercent?: number | null },
  edited: GroupFlags,
): GroupFlagsEditBody {
  const out: GroupFlagsEditBody = {};
  const was = { size: saved.setsPrice === true, halves: saved.allowHalves === true, min: saved.minSelect ?? 0, max: saved.maxSelect ?? 1 };
  if (edited.setsPrice !== was.size) {
    out.setsPrice = edited.setsPrice;
    if (edited.setsPrice && was.halves) out.allowHalves = false;
  }
  if (edited.setsPrice) return out;
  if (edited.allowHalves !== was.halves) out.allowHalves = edited.allowHalves;
  if (edited.allowHalves && safePercent(edited.halfPercent) !== safePercent(saved.halfPricePercent ?? 100)) out.halfPricePercent = safePercent(edited.halfPercent);
  if (!was.size && edited.required !== (saved.isRequired === true)) {
    out.isRequired = edited.required;
    out.minSelect = edited.required ? Math.max(1, was.min) : 0;
  }
  if (!was.size && edited.multi !== (was.max > 1)) {
    out.maxSelect = edited.multi ? MULTI_PICK_MAX : 1;
    if (!edited.multi && (out.minSelect ?? was.min) > 1) out.minSelect = 1;
  }
  return out;
}

// ── The server's refusal ────────────────────────────────────────────────────

// [REVIEW-MENU-B S3-5] APP_UPDATE_REQUIRED: an edit an older app could not show right (the server's plain sentence).
const OWN_WORDS = new Set(['MENU_OPTIONS_RULE', 'SHARED_OPTION_GROUP', 'APP_UPDATE_REQUIRED']);

/** A broken option rule, or an edit of a shared copy: the server's own words (the phone's axios error, or the
 *  website's error with `code` and `message`). Anything else: null (the caller keeps its own sentence). */
export function menuOptionsRefusal(error: unknown): string | null {
  const e = error as { code?: unknown; message?: unknown; response?: { data?: { error?: { code?: unknown; message?: unknown } } } } | null;
  const body = e?.response?.data?.error ?? e;
  if (!body || typeof body.code !== 'string' || !OWN_WORDS.has(body.code)) return null;
  return typeof body.message === 'string' && body.message.trim() ? body.message : null;
}
