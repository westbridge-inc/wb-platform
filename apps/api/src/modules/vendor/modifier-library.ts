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
  options: Array<{ id: string; name: string; followUpGroupId: string | null }>;
};

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
  options: { select: { id: true, name: true, followUpGroupId: true, additionalPrice: true, vatListedAdditionalPrice: true } },
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
      // What the store typed for each size (before VAT while its VAT is added).
      const lowest = Math.min(...size.options.map((o) => Number(o.vatListedAdditionalPrice ?? o.additionalPrice)));
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
export function libraryGraphProblem(groups: ReadonlyArray<{ id: string; name: string; setsPrice: boolean; allowHalves: boolean; isRequired: boolean; minSelect: number; maxSelect: number; options: Array<{ name: string; followUpGroupId: string | null }> }>): string | null {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const followUps = new Set(groups.flatMap((g) => g.options.map((o) => o.followUpGroupId).filter((id): id is string => !!id)));
  for (const g of groups) {
    if (g.minSelect > g.maxSelect) return `"${g.name}": the minimum cannot be more than the maximum.`;
    if (g.setsPrice && (!g.isRequired || g.maxSelect !== 1)) return `"${g.name}" sets the price, so the customer must pick exactly one.`;
    if (g.setsPrice && g.allowHalves) return `"${g.name}" sets the price, so it cannot be half-and-half.`;
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

/** The ids of the item's groups that some option of the item opens (its follow-up groups). */
async function followUpCopyIds(tx: Tx, itemId: string): Promise<Set<string>> {
  const rows = await tx.option.findMany({
    where: { optionGroup: { itemId }, followUpGroupId: { not: null } },
    select: { followUpGroupId: true },
  });
  return new Set(rows.map((r) => r.followUpGroupId!));
}

/** The item's copy of a library group, created (empty) when missing. */
async function ensureCopy(tx: Tx, itemId: string, library: Pick<LibraryGroup, 'id' | 'name' | 'isRequired' | 'minSelect' | 'maxSelect' | 'setsPrice' | 'allowHalves' | 'halfPricePercent'>): Promise<{ id: string; created: boolean }> {
  const existing = await tx.optionGroup.findFirst({ where: { itemId, libraryGroupId: library.id }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };
  const last = await tx.optionGroup.findFirst({ where: { itemId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
  const created = await tx.optionGroup.create({
    data: {
      itemId, libraryGroupId: library.id, name: library.name,
      isRequired: library.isRequired, minSelect: library.minSelect, maxSelect: library.maxSelect,
      setsPrice: library.setsPrice, allowHalves: library.allowHalves, halfPricePercent: library.halfPricePercent,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

/** Write a library group onto ONE copy: the group's settings, every option (kept by libraryOptionId, so a copy
 *  option's id survives every edit), options gone from the library removed, follow-ups pointed at the same item's
 *  copy of the follow-up library group (attached when missing). */
async function writeCopy(tx: Tx, vendorId: string, library: LibraryGroup, copy: { id: string; itemId: string }, depth: number): Promise<void> {
  await tx.optionGroup.update({
    where: { id: copy.id },
    data: {
      name: library.name, isRequired: library.isRequired, minSelect: library.minSelect, maxSelect: library.maxSelect,
      setsPrice: library.setsPrice, allowHalves: library.allowHalves, halfPricePercent: library.halfPricePercent,
    },
  });
  const current = await tx.option.findMany({ where: { optionGroupId: copy.id }, select: { id: true, libraryOptionId: true } });
  const byLibrary = new Map(current.filter((o) => o.libraryOptionId).map((o) => [o.libraryOptionId!, o.id]));
  const keep = new Set(library.options.map((o) => o.id));
  const stale = current.filter((o) => !o.libraryOptionId || !keep.has(o.libraryOptionId)).map((o) => o.id);
  if (stale.length) await tx.option.deleteMany({ where: { id: { in: stale } } });
  for (const option of library.options) {
    let followUpGroupId: string | null = null;
    if (option.followUpGroupId && depth === 0) {
      const target = await libraryGroupOf(tx, vendorId, option.followUpGroupId);
      const targetCopy = await ensureCopy(tx, copy.itemId, target);
      await writeCopy(tx, vendorId, target, { id: targetCopy.id, itemId: copy.itemId }, depth + 1);
      followUpGroupId = targetCopy.id;
    }
    const data = {
      name: option.name, ...typedOptionPrice(option.price), isDefault: option.isDefault,
      isAvailable: option.isAvailable, sortOrder: option.sortOrder, followUpGroupId,
    };
    const id = byLibrary.get(option.id);
    if (id) await tx.option.update({ where: { id }, data });
    else await tx.option.create({ data: { ...data, optionGroupId: copy.id, libraryOptionId: option.id } });
  }
}

/** Remove the item's copies that USED to be follow-ups and no longer are (their opener went away): a follow-up group
 *  left behind would show as an always-open group. A group the store attached itself (never a follow-up) stays. */
async function pruneFormerFollowUps(tx: Tx, itemId: string, before: ReadonlySet<string>): Promise<void> {
  const after = await followUpCopyIds(tx, itemId);
  const gone = [...before].filter((id) => !after.has(id));
  if (gone.length) await tx.optionGroup.deleteMany({ where: { id: { in: gone }, itemId, libraryGroupId: { not: null } } });
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
  for (const copy of copies) {
    const before = await followUpCopyIds(tx, copy.itemId);
    await writeCopy(tx, vendorId, library, copy, 0);
    await pruneFormerFollowUps(tx, copy.itemId, before);
  }
  // A library group that is a follow-up elsewhere: the groups that open it hold its copies; nothing more to do.
  const itemIds = [...new Set(copies.map((c) => c.itemId))];
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
    const copy = await ensureCopy(tx, item.id, library);
    await writeCopy(tx, vendorId, library, { id: copy.id, itemId: item.id }, 0);
    attached.push(item.id);
  }
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
  for (const copy of copies) await detachCopy(tx, copy);
  const detached = [...new Set(copies.map((c) => c.itemId))];
  await settleItems(tx, vendorId, detached);
  return { detached };
}

/** Remove one item's copy of a shared group (and the follow-up groups only it opened). */
export async function detachCopy(tx: Tx, copy: { id: string; itemId: string }): Promise<void> {
  const before = await followUpCopyIds(tx, copy.itemId);
  await tx.optionGroup.delete({ where: { id: copy.id } });
  before.delete(copy.id);
  await pruneFormerFollowUps(tx, copy.itemId, before);
}

/** Delete a library group: it leaves every item it was attached to (the store was told how many), then the library.
 *  Library options that opened it no longer open anything; their items are rewritten. */
export async function deleteLibraryGroup(tx: Tx, vendorId: string, libraryGroupId: string): Promise<{ items: number }> {
  await libraryGroupOf(tx, vendorId, libraryGroupId);
  const copies = await tx.optionGroup.findMany({ where: { libraryGroupId, item: { vendorId } }, select: { id: true, itemId: true } });
  const openers = await tx.modifierOption.findMany({ where: { followUpGroupId: libraryGroupId }, select: { modifierGroupId: true } });
  for (const copy of copies) await detachCopy(tx, copy);
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
