/**
 * [MENU-OPTIONS · owner 11 Nov 2026] The store's SHARED option-group library, and the rules every item's option
 * groups obey (size sets the price, half-and-half, one level of follow-up choices).
 *
 * How sharing works: a library group (ModifierGroup) is attached to an item by writing a COPY of it onto the item
 * (an ordinary OptionGroup with libraryGroupId set, each option with libraryOptionId). Every reader of an item's
 * options (cart quote, checkout, storefront, kitchen, menu copy, export, the older apps) keeps reading the item's own
 * rows, unchanged. The library is the only editor of a copy: every library edit rewrites every copy in the same
 * transaction (syncLibraryGroup), keeping each copy option's id while the library option exists (carts hold those
 * ids), so editing a shared group updates every attached item at once.
 *
 * Prices in the library are what the store TYPED (before VAT). A copy's option price is written as typed and then
 * reconciled with its item's VAT (store-vat/vat-pricing.ts), exactly like an option typed on the item.
 *
 * Every write here ends with `settleItems`: the item's option rules are checked (a broken graph rolls the whole
 * write back), the item's "from" price follows its sizes, and its VAT is reconciled.
 */
import { Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { reconcileVatPricing, typedItemPrice, typedOptionPrice } from '../store-vat/vat-pricing';

type Tx = Prisma.TransactionClient;

/** [REVIEW A S3-3 · B S2-2] A library write reaches every item that uses the group (attach takes up to 500 at once):
 *  one minute, like the menu copy, never Prisma's default 5 s (a big menu failed with "Transaction already closed"). */
export const LIBRARY_TX = { timeout: 60_000, maxWait: 10_000 } as const;

/** A broken option rule: refused with the plain reason, nothing written (the transaction rolls back). */
export function menuOptionsRule(message: string): AppError {
  return new AppError(400, 'MENU_OPTIONS_RULE', message);
}

/** The refusal of an edit made on an item's copy of a shared group. */
export const SHARED_GROUP_EDIT_MESSAGE =
  'This option group is shared by several items. Edit it in the option library (Menu → Option library), and every item that uses it changes.';
export function sharedGroupEditRefusal(): AppError {
  return new AppError(409, 'SHARED_OPTION_GROUP', SHARED_GROUP_EDIT_MESSAGE);
}

/** A price-setting group is always "pick exactly one" (the DB holds the same check). */
export function normalizedGroupFlags<T extends { isRequired?: boolean; minSelect?: number; maxSelect?: number; setsPrice?: boolean; allowHalves?: boolean; halfPricePercent?: number }>(body: T): T {
  if (body.setsPrice !== true) return body;
  if (body.allowHalves === true) throw menuOptionsRule('A group that sets the price (like Size) cannot be half-and-half.');
  return { ...body, isRequired: true, minSelect: 1, maxSelect: 1 };
}

// ---------------------------------------------------------------------------
// The item's rules
// ---------------------------------------------------------------------------

type GraphGroup = {
  id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number;
  setsPrice: boolean; allowHalves: boolean; halfPricePercent: number;
  options: Array<{ id: string; name: string; followUpGroupId: string | null; additionalPrice?: unknown; vatListedAdditionalPrice?: unknown }>;
};

/** [REVIEW B S2-1 · S3-3] A size's price IS the item's price: never $0 (a blank or mistyped price, or an add-on group
 *  switched to "Sets the price" without its prices, would sell the item for nothing). */
export const SIZE_NEEDS_PRICE = (group: string, size: string) =>
  `"${size}" is a size of "${group}", so it needs its full price (more than $0).`;
export const SIZE_GROUP_EMPTY = (group: string) =>
  `"${group}" sets the price, so it needs at least one size with its price.`;

/** The rules of one item's groups, as one judgement over the whole graph (pure; the routes and the library call it
 *  after every write, inside the write's transaction). */
export function itemOptionRulesProblem(groups: readonly GraphGroup[]): string | null {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const sizes = groups.filter((g) => g.setsPrice);
  if (sizes.length > 1) return 'An item can have only one group that sets the price (like Size).';
  for (const g of groups) {
    if (g.minSelect > g.maxSelect) return `"${g.name}": the minimum cannot be more than the maximum.`;
    if (g.setsPrice && (!g.isRequired || g.maxSelect !== 1)) return `"${g.name}" sets the price, so the customer must pick exactly one.`;
    if (g.setsPrice && g.allowHalves) return `"${g.name}" sets the price, so it cannot be half-and-half.`;
    if (g.setsPrice && g.options.length === 0) return SIZE_GROUP_EMPTY(g.name);
    if (g.setsPrice) {
      for (const o of g.options) {
        if (o.additionalPrice === undefined) continue;
        if (!(Number(o.vatListedAdditionalPrice ?? o.additionalPrice) > 0)) return SIZE_NEEDS_PRICE(g.name, o.name);
      }
    }
    if (!Number.isInteger(g.halfPricePercent) || g.halfPricePercent < 1 || g.halfPricePercent > 100) return `"${g.name}": a half costs 1% to 100% of the choice's price.`;
  }
  const followUps = new Set(groups.flatMap((g) => g.options.map((o) => o.followUpGroupId).filter((id): id is string => !!id)));
  for (const g of groups) {
    for (const o of g.options) {
      if (!o.followUpGroupId) continue;
      const target = byId.get(o.followUpGroupId);
      if (!target) return `"${o.name}" opens a group that is not on this item.`;
      if (target.id === g.id) return `"${o.name}" cannot open its own group.`;
      if (target.setsPrice) return `"${o.name}" cannot open "${target.name}": a group that sets the price is always shown.`;
      if (followUps.has(g.id)) return `"${o.name}" is a follow-up choice, so it cannot open another group (one level only).`;
    }
  }
  return null;
}

const GRAPH_SELECT = {
  id: true, name: true, isRequired: true, minSelect: true, maxSelect: true,
  setsPrice: true, allowHalves: true, halfPricePercent: true,
  options: { select: { id: true, name: true, followUpGroupId: true, additionalPrice: true, vatListedAdditionalPrice: true, isAvailable: true } },
} as const;

/**
 * After any write to items' option groups: refuse a broken graph, keep each item's "from" price at its lowest size
 * (an older app and every list show basePrice; checkout prices a sized item from the chosen size, never from it),
 * and reconcile the VAT of every price just written. One call per write, inside its transaction.
 */
export async function settleItems(tx: Tx, vendorId: string, itemIds: readonly string[]): Promise<void> {
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0) return;
  const items = await tx.item.findMany({
    where: { id: { in: ids }, vendorId },
    select: { id: true, name: true, basePrice: true, vatListedPrice: true, optionGroups: { select: GRAPH_SELECT } },
  });
  for (const item of items) {
    const problem = itemOptionRulesProblem(item.optionGroups);
    if (problem) throw menuOptionsRule(items.length > 1 ? `${item.name}: ${problem}` : problem);
    const size = item.optionGroups.find((g) => g.setsPrice);
    if (size && size.options.length > 0) {
      // What the store typed for each size (before VAT while its VAT is added). [REVIEW A S4-6] The "from" price is
      // the lowest size ON SALE (a sold-out size is a price nobody can buy now); all sizes when every one is sold out.
      const onSale = size.options.filter((o) => o.isAvailable !== false);
      const lowest = Math.min(...(onSale.length ? onSale : size.options).map((o) => Number(o.vatListedAdditionalPrice ?? o.additionalPrice)));
      const typed = Number(item.vatListedPrice ?? item.basePrice);
      if (lowest !== typed) await tx.item.update({ where: { id: item.id }, data: typedItemPrice(lowest) });
    }
  }
  await reconcileVatPricing(tx, vendorId, { itemIds: ids });
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

const LIBRARY_INCLUDE = {
  options: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ModifierGroupInclude;

type LibraryGroup = Prisma.ModifierGroupGetPayload<{ include: typeof LIBRARY_INCLUDE }>;

/** The library's own rules (pure): a follow-up group is one level deep and never sets the price. */
export function libraryGraphProblem(groups: ReadonlyArray<{ id: string; name: string; setsPrice: boolean; allowHalves: boolean; isRequired: boolean; minSelect: number; maxSelect: number; options: Array<{ name: string; followUpGroupId: string | null; price?: unknown }> }>): string | null {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const followUps = new Set(groups.flatMap((g) => g.options.map((o) => o.followUpGroupId).filter((id): id is string => !!id)));
  for (const g of groups) {
    if (g.minSelect > g.maxSelect) return `"${g.name}": the minimum cannot be more than the maximum.`;
    if (g.setsPrice && (!g.isRequired || g.maxSelect !== 1)) return `"${g.name}" sets the price, so the customer must pick exactly one.`;
    if (g.setsPrice && g.allowHalves) return `"${g.name}" sets the price, so it cannot be half-and-half.`;
    // [REVIEW B S2-1 · S3-3] A shared size is never $0 either (an empty shared size group may exist until it is
    // attached: an item's size group needs a size, settleItems).
    if (g.setsPrice) for (const o of g.options) if (o.price !== undefined && !(Number(o.price) > 0)) return SIZE_NEEDS_PRICE(g.name, o.name);
    for (const o of g.options) {
      if (!o.followUpGroupId) continue;
      const target = byId.get(o.followUpGroupId);
      if (!target) return `"${o.name}" opens a group that is not in this store's library.`;
      if (target.id === g.id) return `"${o.name}" cannot open its own group.`;
      if (target.setsPrice) return `"${o.name}" cannot open "${target.name}": a group that sets the price is always shown.`;
      if (followUps.has(g.id)) return `"${o.name}" is a follow-up choice, so it cannot open another group (one level only).`;
    }
  }
  return null;
}

/** Refuse a library whose follow-ups break the rules (the whole store library, inside the write's transaction). */
export async function assertLibraryRules(tx: Tx, vendorId: string): Promise<void> {
  const groups = await tx.modifierGroup.findMany({ where: { vendorId }, include: LIBRARY_INCLUDE });
  const problem = libraryGraphProblem(groups);
  if (problem) throw menuOptionsRule(problem);
}

/** One library group of this store, or 404 (another store's id is simply not found). */
export async function libraryGroupOf(tx: Tx, vendorId: string, id: string): Promise<LibraryGroup> {
  const group = await tx.modifierGroup.findFirst({ where: { id, vendorId }, include: LIBRARY_INCLUDE });
  if (!group) throw new NotFoundError('ModifierGroup', id);
  return group;
}

type CopyRef = { id: string; itemId: string };
type GroupFields = Pick<LibraryGroup, 'id' | 'name' | 'isRequired' | 'minSelect' | 'maxSelect' | 'setsPrice' | 'allowHalves' | 'halfPricePercent'>;

/** Each item's groups that some option of the item opens (its follow-up groups): one read for all the items. */
async function followUpCopyIds(tx: Tx, itemIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(itemIds.map((id) => [id, new Set<string>()]));
  if (itemIds.length === 0) return out;
  const rows = await tx.option.findMany({
    where: { optionGroup: { itemId: { in: [...itemIds] } }, followUpGroupId: { not: null } },
    select: { followUpGroupId: true, optionGroup: { select: { itemId: true } } },
  });
  for (const r of rows) out.get(r.optionGroup.itemId)?.add(r.followUpGroupId!);
  return out;
}

const groupFields = (library: GroupFields) => ({
  name: library.name, isRequired: library.isRequired, minSelect: library.minSelect, maxSelect: library.maxSelect,
  setsPrice: library.setsPrice, allowHalves: library.allowHalves, halfPricePercent: library.halfPricePercent,
});

/** The items' copies of a library group, created (empty, last in each item's order) where missing: item id -> copy id.
 *  A few queries for any number of items. */
async function ensureCopies(tx: Tx, itemIds: readonly string[], library: GroupFields): Promise<Map<string, string>> {
  const ids = [...new Set(itemIds)];
  const have = new Map<string, string>();
  if (ids.length === 0) return have;
  const existing = await tx.optionGroup.findMany({ where: { itemId: { in: ids }, libraryGroupId: library.id }, select: { id: true, itemId: true } });
  for (const e of existing) have.set(e.itemId, e.id);
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length) {
    const lasts = await tx.optionGroup.groupBy({ by: ['itemId'], where: { itemId: { in: missing } }, _max: { sortOrder: true } });
    const next = new Map(lasts.map((l) => [l.itemId, (l._max.sortOrder ?? -1) + 1]));
    await tx.optionGroup.createMany({
      data: missing.map((itemId) => ({ itemId, libraryGroupId: library.id, ...groupFields(library), sortOrder: next.get(itemId) ?? 0 })),
    });
    const made = await tx.optionGroup.findMany({ where: { itemId: { in: missing }, libraryGroupId: library.id }, select: { id: true, itemId: true } });
    for (const m of made) have.set(m.itemId, m.id);
  }
  return have;
}

/** Write a library group onto its copies, all at once: the group's settings, every option (kept by libraryOptionId,
 *  so a copy option's id survives every edit), options gone from the library removed, follow-ups pointed at the same
 *  item's copy of the follow-up library group (attached when missing). [REVIEW A S3-3 · B S2-2] One write per library
 *  choice for ALL the copies (plus one per copy only for a choice that opens a follow-up), never one per copy per
 *  choice: a 20-choice group on 500 items is a few dozen queries, not ten thousand. */
async function writeCopies(tx: Tx, vendorId: string, library: LibraryGroup, copies: readonly CopyRef[], depth: number): Promise<void> {
  if (copies.length === 0) return;
  const copyIds = copies.map((c) => c.id);
  await tx.optionGroup.updateMany({ where: { id: { in: copyIds } }, data: groupFields(library) });
  const current = await tx.option.findMany({ where: { optionGroupId: { in: copyIds } }, select: { id: true, optionGroupId: true, libraryOptionId: true } });
  const keep = new Set(library.options.map((o) => o.id));
  const stale = current.filter((o) => !o.libraryOptionId || !keep.has(o.libraryOptionId)).map((o) => o.id);
  if (stale.length) await tx.option.deleteMany({ where: { id: { in: stale } } });
  const has = new Set(current.filter((o) => o.libraryOptionId && keep.has(o.libraryOptionId)).map((o) => `${o.optionGroupId}|${o.libraryOptionId}`));

  // Follow-up groups (one level): each item's copy of the target library group, written first.
  const targets = new Map<string, Map<string, string>>();
  if (depth === 0) {
    for (const targetId of new Set(library.options.map((o) => o.followUpGroupId).filter((id): id is string => !!id))) {
      const target = await libraryGroupOf(tx, vendorId, targetId);
      const byItem = await ensureCopies(tx, copies.map((c) => c.itemId), target);
      await writeCopies(tx, vendorId, target, copies.map((c) => ({ id: byItem.get(c.itemId)!, itemId: c.itemId })), depth + 1);
      targets.set(targetId, byItem);
    }
  }

  const creates: Prisma.OptionCreateManyInput[] = [];
  for (const option of library.options) {
    const shared = { name: option.name, ...typedOptionPrice(option.price), isDefault: option.isDefault, isAvailable: option.isAvailable, sortOrder: option.sortOrder };
    const target = depth === 0 && option.followUpGroupId ? targets.get(option.followUpGroupId) : undefined;
    const present = copies.filter((c) => has.has(`${c.id}|${option.id}`));
    if (present.length) {
      await tx.option.updateMany({
        where: { optionGroupId: { in: present.map((c) => c.id) }, libraryOptionId: option.id },
        data: { ...shared, ...(target ? {} : { followUpGroupId: null }) },
      });
      if (target) {
        for (const c of present) {
          await tx.option.updateMany({ where: { optionGroupId: c.id, libraryOptionId: option.id }, data: { followUpGroupId: target.get(c.itemId)! } });
        }
      }
    }
    for (const c of copies) {
      if (has.has(`${c.id}|${option.id}`)) continue;
      creates.push({ ...shared, optionGroupId: c.id, libraryOptionId: option.id, followUpGroupId: target ? target.get(c.itemId)! : null });
    }
  }
  if (creates.length) await tx.option.createMany({ data: creates });
}

/** Remove the items' copies that USED to be follow-ups and no longer are (their opener went away): a follow-up group
 *  left behind would show as an always-open group. A group the store attached itself (never a follow-up) stays. */
async function pruneFormerFollowUps(tx: Tx, before: ReadonlyMap<string, ReadonlySet<string>>): Promise<void> {
  const after = await followUpCopyIds(tx, [...before.keys()]);
  const gone = [...before].flatMap(([itemId, ids]) => [...ids].filter((id) => !after.get(itemId)?.has(id)));
  if (gone.length) await tx.optionGroup.deleteMany({ where: { id: { in: gone }, libraryGroupId: { not: null } } });
}

/**
 * Rewrite every copy of a library group (or only those on `onlyItemIds`) from the library, then settle the items.
 * Returns the items whose options changed.
 */
export async function syncLibraryGroup(tx: Tx, vendorId: string, libraryGroupId: string, onlyItemIds?: readonly string[]): Promise<string[]> {
  const library = await libraryGroupOf(tx, vendorId, libraryGroupId);
  const copies = await tx.optionGroup.findMany({
    where: { libraryGroupId, item: { vendorId }, ...(onlyItemIds ? { itemId: { in: [...onlyItemIds] } } : {}) },
    select: { id: true, itemId: true },
    orderBy: { id: 'asc' },
  });
  const itemIds = [...new Set(copies.map((c) => c.itemId))];
  const before = await followUpCopyIds(tx, itemIds);
  await writeCopies(tx, vendorId, library, copies, 0);
  await pruneFormerFollowUps(tx, before);
  // A library group that is a follow-up elsewhere: the groups that open it hold its copies; nothing more to do.
  await settleItems(tx, vendorId, itemIds);
  return itemIds;
}

/** [REVIEW B S2-2] A shared choice sold out / back on: every copy of it in one write (no full rewrite), and the items
 *  settled (their "from" price ignores a sold-out size). */
export async function setLibraryOptionAvailability(tx: Tx, vendorId: string, libraryOptionId: string, isAvailable: boolean): Promise<string[]> {
  await tx.modifierOption.update({ where: { id: libraryOptionId }, data: { isAvailable } });
  const copies = await tx.option.findMany({
    where: { libraryOptionId, optionGroup: { item: { vendorId } } },
    select: { id: true, optionGroup: { select: { itemId: true } } },
  });
  if (copies.length) await tx.option.updateMany({ where: { id: { in: copies.map((c) => c.id) } }, data: { isAvailable } });
  const itemIds = [...new Set(copies.map((c) => c.optionGroup.itemId))];
  await settleItems(tx, vendorId, itemIds);
  return itemIds;
}

/** Attach a library group to items (bulk). An item that already has it keeps it unchanged. */
export async function attachLibraryGroup(tx: Tx, vendorId: string, libraryGroupId: string, itemIds: readonly string[]): Promise<{ attached: string[]; already: string[] }> {
  const library = await libraryGroupOf(tx, vendorId, libraryGroupId);
  const ids = [...new Set(itemIds)].sort();
  const items = await tx.item.findMany({
    where: { id: { in: ids }, vendorId, archivedAt: null },
    select: { id: true, name: true, optionGroups: { select: { id: true, setsPrice: true, libraryGroupId: true } } },
  });
  if (items.length !== ids.length) {
    const found = new Set(items.map((i) => i.id));
    throw new NotFoundError('Item', ids.find((id) => !found.has(id)));
  }
  const attached: string[] = [];
  const already: string[] = [];
  for (const item of items) {
    if (item.optionGroups.some((g) => g.libraryGroupId === library.id)) { already.push(item.id); continue; }
    if (library.setsPrice && item.optionGroups.some((g) => g.setsPrice)) {
      throw menuOptionsRule(`${item.name} already has a group that sets the price. Remove it first, or attach this group to other items.`);
    }
    attached.push(item.id);
  }
  const byItem = await ensureCopies(tx, attached, library);
  await writeCopies(tx, vendorId, library, attached.map((itemId) => ({ id: byItem.get(itemId)!, itemId })), 0);
  await settleItems(tx, vendorId, attached);
  return { attached, already };
}

/** Detach a library group from items (bulk): the item's copy is removed, and any follow-up group only it opened. */
export async function detachLibraryGroup(tx: Tx, vendorId: string, libraryGroupId: string, itemIds: readonly string[]): Promise<{ detached: string[] }> {
  await libraryGroupOf(tx, vendorId, libraryGroupId);
  const copies = await tx.optionGroup.findMany({
    where: { libraryGroupId, itemId: { in: [...new Set(itemIds)] }, item: { vendorId } },
    select: { id: true, itemId: true },
  });
  await detachCopies(tx, copies);
  const detached = [...new Set(copies.map((c) => c.itemId))];
  await settleItems(tx, vendorId, detached);
  return { detached };
}

/** Remove items' copies of a shared group (and the follow-up groups only they opened), all at once. */
async function detachCopies(tx: Tx, copies: readonly CopyRef[]): Promise<void> {
  if (copies.length === 0) return;
  const before = await followUpCopyIds(tx, [...new Set(copies.map((c) => c.itemId))]);
  await tx.optionGroup.deleteMany({ where: { id: { in: copies.map((c) => c.id) } } });
  for (const c of copies) before.get(c.itemId)?.delete(c.id);
  await pruneFormerFollowUps(tx, before);
}

/** Remove one item's copy of a shared group (and the follow-up groups only it opened). */
export async function detachCopy(tx: Tx, copy: CopyRef): Promise<void> {
  await detachCopies(tx, [copy]);
}

/** Delete a library group: it leaves every item it was attached to (the store was told how many), then the library.
 *  Library options that opened it no longer open anything; their items are rewritten. */
export async function deleteLibraryGroup(tx: Tx, vendorId: string, libraryGroupId: string): Promise<{ items: number }> {
  await libraryGroupOf(tx, vendorId, libraryGroupId);
  const copies = await tx.optionGroup.findMany({ where: { libraryGroupId, item: { vendorId } }, select: { id: true, itemId: true } });
  const openers = await tx.modifierOption.findMany({ where: { followUpGroupId: libraryGroupId }, select: { modifierGroupId: true } });
  await detachCopies(tx, copies);
  await tx.modifierGroup.delete({ where: { id: libraryGroupId } });
  for (const groupId of new Set(openers.map((o) => o.modifierGroupId))) await syncLibraryGroup(tx, vendorId, groupId);
  const itemIds = [...new Set(copies.map((c) => c.itemId))];
  await settleItems(tx, vendorId, itemIds);
  return { items: itemIds.length };
}

/** The library as the store tools show it: each group with its options, how many live items use it (and which),
 *  and whether another library choice opens it (a follow-up group). */
export async function readLibrary(tx: Tx | Prisma.TransactionClient, vendorId: string) {
  const groups = await tx.modifierGroup.findMany({
    where: { vendorId },
    include: LIBRARY_INCLUDE,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  const uses = groups.length
    ? await tx.optionGroup.findMany({
      where: { libraryGroupId: { in: groups.map((g) => g.id) }, item: { vendorId, archivedAt: null } },
      select: { libraryGroupId: true, item: { select: { id: true, name: true } } },
    })
    : [];
  const followUps = new Set(groups.flatMap((g) => g.options.map((o) => o.followUpGroupId).filter((id): id is string => !!id)));
  return groups.map((g) => {
    const items = uses.filter((u) => u.libraryGroupId === g.id).map((u) => u.item);
    return {
      id: g.id, name: g.name, isRequired: g.isRequired, minSelect: g.minSelect, maxSelect: g.maxSelect, sortOrder: g.sortOrder,
      setsPrice: g.setsPrice, allowHalves: g.allowHalves, halfPricePercent: g.halfPricePercent,
      isFollowUp: followUps.has(g.id),
      usedByItemCount: items.length,
      usedByItems: items.slice(0, 200),
      options: g.options.map((o) => ({
        id: o.id, name: o.name, price: Number(o.price), isDefault: o.isDefault, isAvailable: o.isAvailable,
        sortOrder: o.sortOrder, followUpGroupId: o.followUpGroupId, externalCode: o.externalCode,
      })),
    };
  });
}
