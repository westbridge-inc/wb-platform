/**
 * [STORE-VAT · owner O-5] The VAT frozen on an order, written by ONE function.
 *
 * Checkout freezes the seller's approved VAT number, its registered name and the rate (`vatTermsForCheckout`,
 * read inside the checkout transaction) and each line's VAT class; then `recomputeOrderVat` writes the amounts.
 * Every later change to the order's goods (an approved substitution, a removed line) calls `recomputeOrderVat`
 * again in its own transaction, so the VAT always matches the goods the customer is charged for.
 *
 * Money: on an order whose store's prices include VAT the VAT is inside the goods (vat-math.ts) and no money moves. An
 * order frozen without VAT (`vatRateBps` null) never gains it later, and an order frozen with VAT keeps it whatever the
 * store or the switch does next.
 *
 * [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] An order of a store pricing BEFORE VAT freezes `vatOnTop`: its VAT is ADDED
 * as one "VAT 14%" line, carried in Order.taxAmount (= vatAmount) and inside totalAmount. Checkout prices it with the
 * basket (cart-plans priceBasket, the same `orderVat`), and `recomputeOrderVat` moves taxAmount AND totalAmount by the
 * change in VAT whenever the goods change, in the same transaction, so the total is always goods - discount + fees + VAT.
 */
import { Prisma } from '@prisma/client';
import { lineChangeDiscount, type LineDiscountChange, type LineDiscountRedemption } from '../order/line-discount';
import { orderVat, type OrderVatResult, type VatClassName } from './vat-math';
import { STORE_VAT_RATE_BPS, STORE_VAT_RATE_PERCENT } from './vat-rate';
import { STORE_VAT_SELECT, storeVatEffective, storeVatOnTop } from './store-vat';

type Db = Prisma.TransactionClient;

/** A line that came off the order was never charged (order/receipt.ts uses the same two states). */
const REMOVED_SUB_STATUSES: ReadonlySet<string> = new Set(['REFUNDED', 'REJECTED']);

export interface OrderVatTerms {
  sellerNumber: string;
  sellerName: string;
  rateBps: number;
  /** [STORE-VAT-EXCLUSIVE] The store prices before VAT: the VAT is added as its own line (Order.vatOnTop). */
  onTop: boolean;
}

function termsOf(vendor: Parameters<typeof storeVatEffective>[0] & { vatApprovedNumber: string | null; vatApprovedName: string | null }, env: Record<string, string | undefined>, now: Date): OrderVatTerms | null {
  if (!storeVatEffective(vendor, env, now)) return null;
  return { sellerNumber: vendor.vatApprovedNumber!, sellerName: vendor.vatApprovedName!, rateBps: STORE_VAT_RATE_BPS, onTop: storeVatOnTop(vendor, env, now) };
}

/** What an order placed now at this store freezes; null = the order carries no VAT. */
export async function vatTermsForCheckout(db: Db, vendorId: string, env: Record<string, string | undefined> = process.env, now: Date = new Date()): Promise<OrderVatTerms | null> {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: STORE_VAT_SELECT });
  return vendor ? termsOf(vendor, env, now) : null;
}

/** [STORE-VAT-EXCLUSIVE] The same terms for several stores in one read (the cart quote and checkout's pricing). */
export async function vatTermsByVendor(
  db: Pick<Prisma.TransactionClient, 'vendor'>, vendorIds: readonly string[],
  env: Record<string, string | undefined> = process.env, now: Date = new Date(),
): Promise<Map<string, OrderVatTerms>> {
  const out = new Map<string, OrderVatTerms>();
  if (vendorIds.length === 0) return out;
  const vendors = await db.vendor.findMany({ where: { id: { in: [...new Set(vendorIds)] } }, select: STORE_VAT_SELECT });
  for (const vendor of vendors) {
    const terms = termsOf(vendor, env, now);
    if (terms) out.set(vendor.id, terms);
  }
  return out;
}

/** [STORE-VAT-EXCLUSIVE] The VAT a basket plan adds on top (cart-plans BasketPlan.vatOnTop): null unless the store prices
 *  before VAT. `lines` are the plan's lines in the order checkout writes them, each with its item's VAT class. */
export function vatOnTopPlan(
  terms: OrderVatTerms | null | undefined,
  lines: ReadonlyArray<{ amount: number; vatClass: string | null | undefined }>,
): { rateBps: number; lines: Array<{ id: string; amount: number; vatClass: VatClassName }> } | null {
  if (!terms?.onTop) return null;
  // [REVIEW-A F4 · REVIEW-B S4-2] In the ONE split order (inVatSplitOrder), the order checkout stores the store
  // discount's line shares in: the priced VAT and the placed order's VAT can never differ by which line came first.
  return { rateBps: terms.rateBps, lines: inVatSplitOrder(lines, (l) => l.vatClass).map((l, i) => ({ id: String(i), amount: l.amount, vatClass: classOf(l.vatClass) })) };
}

const SPLIT_RANK: Readonly<Record<VatClassName, number>> = { STANDARD: 0, ZERO_RATED: 1, EXEMPT: 2 };

/**
 * [REVIEW-A F4 · REVIEW-B S4-2] The ONE line order a store's goods discount is split in on an order whose VAT is added on
 * top: standard-rated lines first, then zero-rated, then exempt, each kept in its own order. The split
 * (allocateAcrossLines, largest remainder) breaks a tie by position, so the same basket in two orders could give the
 * extra dollar of discount to a standard-rated line on one side and a zero-rated line on the other: VAT 132 on the quote,
 * 133 on the placed order, and a cart that is refused on every try (two lines of 1,000, one of each class, a store
 * discount of 107). With the classes in a fixed order, whichever line of a class takes a tie, the VAT is the same: both the
 * pricer (vatOnTopPlan) and checkout's stored shares (lineAllocations) use this order.
 */
export function inVatSplitOrder<T>(lines: readonly T[], vatClassOf: (line: T) => string | null | undefined): T[] {
  return lines
    .map((line, index) => ({ line, index, rank: SPLIT_RANK[classOf(vatClassOf(line))] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.line);
}

function classOf(raw: string | null | undefined): VatClassName {
  return raw === 'ZERO_RATED' || raw === 'EXEMPT' ? raw : 'STANDARD';
}

/** The order columns checkout writes with its row (the amounts follow from `recomputeOrderVat`). */
export function orderVatCreateFields(terms: OrderVatTerms | null): { vatRateBps?: number; vatSellerNumber?: string; vatSellerName?: string; vatOnTop?: boolean } {
  return terms ? { vatRateBps: terms.rateBps, vatSellerNumber: terms.sellerNumber, vatSellerName: terms.sellerName, ...(terms.onTop ? { vatOnTop: true } : {}) } : {};
}

/** A line's class as checkout freezes it: the item's class for a VAT order, nothing otherwise. */
export function lineVatClass(terms: OrderVatTerms | null, itemClass: string | null | undefined): VatClassName | undefined {
  if (!terms) return undefined;
  return itemClass === 'ZERO_RATED' || itemClass === 'EXEMPT' ? itemClass : 'STANDARD';
}

function lineShares(raw: unknown): Map<string, number> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const shares = new Map<string, number>();
  for (const a of raw as Array<{ orderItemId?: unknown; goods?: unknown }>) {
    if (typeof a?.orderItemId === 'string') shares.set(a.orderItemId, Math.max(0, Number(a.goods) || 0));
  }
  return shares;
}

/**
 * [REVIEW-M #2085 S3-1] The goods discount that lowers the STORE's VAT. VAT Act s.2: the store's consideration is what is
 * "paid or payable ... by any person, directly or indirectly", less the discounts the supplier allows. A discount Swift
 * funds is paid to the store by Swift (billing sales-components: sponsorReceivable), so it never lowers the store's VAT;
 * only a discount the STORE gives does (funder VENDOR). An order with a goods discount but no redemption row is the
 * store's own, as billing counts it (sales-components). Returns what orderVat takes.
 */
export function vatDiscountFor(
  redemption: { funder: string; goodsDiscount: unknown; lineAllocations: unknown } | null | undefined,
  orderGoodsDiscount: number,
): { lineGoodsDiscounts?: ReadonlyMap<string, number>; goodsDiscount?: number } {
  if (!redemption) return { goodsDiscount: Math.max(0, orderGoodsDiscount) };
  if (redemption.funder !== 'VENDOR') return { goodsDiscount: 0 };
  const shares = lineShares(redemption.lineAllocations);
  return shares ? { lineGoodsDiscounts: shares } : { goodsDiscount: Math.max(0, Number(redemption.goodsDiscount) || 0) };
}

/** The order columns the VAT amounts are written to (Decimal, like every money column). */
export function orderVatAmountFields(result: OrderVatResult) {
  return {
    vatAmount: new Prisma.Decimal(result.vatAmount),
    vatStandardGoods: new Prisma.Decimal(result.standardGoods),
    vatZeroRatedGoods: new Prisma.Decimal(result.zeroRatedGoods),
    vatExemptGoods: new Prisma.Decimal(result.exemptGoods),
    vatBase: new Prisma.Decimal(result.vatBase),
  };
}

/** [STORE-VAT-EXCLUSIVE] The VAT of an order's goods as they stand (the one computation recompute and every preview use). */
function vatOfOrderLines(order: {
  vatRateBps: number;
  vatOnTop: boolean;
  discount: unknown;
  lines: ReadonlyArray<{ id: string; amount: number; vatClass: string | null | undefined }>;
  promoRedemption: { funder: string; goodsDiscount: unknown; lineAllocations: unknown } | null | undefined;
}): OrderVatResult {
  const lines = order.lines.map((l) => ({ id: l.id, amount: Math.max(0, l.amount), vatClass: classOf(l.vatClass) }));
  const goods = lines.reduce((sum, l) => sum + l.amount, 0);
  return orderVat({
    lines,
    // Only a discount the STORE gave lowers its VAT (vatDiscountFor); a Swift-funded one never does.
    ...vatDiscountFor(order.promoRedemption, Math.min(goods, Number(order.discount) || 0)),
    // The rate the order froze, never today's: a later rate change never reaches a placed order.
    rateBps: order.vatRateBps,
    basis: order.vatOnTop ? 'ON_TOP' : 'INCLUDED',
  });
}

/**
 * Write the order's VAT from its lines as they stand. A no-op (null) for an order frozen without VAT.
 * The goods discount comes off only when the STORE funded it (vatDiscountFor), by the line shares the promo
 * redemption stored (M-33); a discount Swift pays for leaves the store's VAT on the full goods price.
 *
 * [STORE-VAT-EXCLUSIVE] On an order whose VAT is added on top (vatOnTop), taxAmount becomes the new VAT and totalAmount
 * moves by exactly the change (`taxDelta`), in the caller's transaction: the "VAT 14%" line and the Total always agree
 * with the goods still on the order. Callers that state or release money read `taxDelta` (0 on every other order).
 */
export async function recomputeOrderVat(db: Db, orderId: string): Promise<(OrderVatResult & { taxDelta: number }) | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      vatRateBps: true,
      vatOnTop: true,
      taxAmount: true,
      discount: true,
      items: { select: { id: true, totalCustomer: true, vatClass: true, subStatus: true } },
      promoRedemption: { select: { funder: true, goodsDiscount: true, lineAllocations: true } },
    },
  });
  if (!order || order.vatRateBps == null) return null;
  const result = vatOfOrderLines({
    vatRateBps: order.vatRateBps,
    vatOnTop: order.vatOnTop,
    discount: order.discount,
    lines: order.items.map((it) => ({ id: it.id, amount: REMOVED_SUB_STATUSES.has(it.subStatus) ? 0 : Number(it.totalCustomer), vatClass: it.vatClass })),
    promoRedemption: order.promoRedemption,
  });
  const taxDelta = order.vatOnTop ? result.vatAmount - Number(order.taxAmount) : 0;
  await db.order.update({ where: { id: orderId }, data: recomputedVatData(result, order.vatOnTop, taxDelta) });
  return { ...result, taxDelta };
}

/** The columns a recompute writes: the VAT amounts, and on an order whose VAT is added on top its "VAT 14%" line
 *  (taxAmount) and the total moved by exactly the change. Never the status. */
function recomputedVatData(result: OrderVatResult, vatOnTop: boolean, taxDelta: number): Prisma.OrderUpdateInput {
  return {
    ...orderVatAmountFields(result),
    ...(vatOnTop ? { taxAmount: new Prisma.Decimal(result.vatAmount) } : {}),
    ...(taxDelta !== 0 ? { totalAmount: { increment: new Prisma.Decimal(taxDelta) } } : {}),
  };
}

/**
 * [STORE-VAT-EXCLUSIVE] What a picking change (a line off, or swapped) does to an order's added VAT, BEFORE it happens:
 * the change in its "VAT 14%" line, so the customer's card, the question's push and the change itself say the same
 * total. The same rule recompute applies after the change: the discount that goes with the change (line-discount.ts),
 * the line's new amount, the substitute's VAT class. 0 on every order whose VAT is not added on top.
 */
export function vatOnTopChange(order: {
  vatRateBps: number | null | undefined;
  vatOnTop?: boolean | null;
  vatAmount: unknown;
  discount: unknown;
  items: ReadonlyArray<{ id: string; subStatus: string; totalCustomer: unknown; vatClass?: string | null }>;
  promoRedemption: (LineDiscountRedemption & { funder: string }) | null | undefined;
}, change: LineDiscountChange & { vatClass?: string | null }): number {
  if (!order.vatOnTop || order.vatRateBps == null) return 0;
  const live = order.items.filter((i) => !REMOVED_SUB_STATUSES.has(i.subStatus));
  const moved = lineChangeDiscount({
    orderDiscount: order.discount,
    live: live.map((l) => ({ id: l.id, amount: Number(l.totalCustomer) })),
    change,
    redemption: order.promoRedemption ?? null,
  });
  const redemptionAfter = order.promoRedemption
    ? { funder: order.promoRedemption.funder, goodsDiscount: moved.redemption?.goodsDiscount ?? order.promoRedemption.goodsDiscount, lineAllocations: moved.redemption?.lineAllocations ?? order.promoRedemption.lineAllocations }
    : null;
  const after = vatOfOrderLines({
    vatRateBps: order.vatRateBps,
    vatOnTop: true,
    discount: Math.max(0, (Number(order.discount) || 0) - moved.amount),
    lines: order.items.map((it) => it.id === change.lineId
      ? { id: it.id, amount: change.newLineTotal, vatClass: change.vatClass === undefined ? it.vatClass : change.vatClass }
      : { id: it.id, amount: REMOVED_SUB_STATUSES.has(it.subStatus) ? 0 : Number(it.totalCustomer), vatClass: it.vatClass }),
    promoRedemption: redemptionAfter,
  });
  return after.vatAmount - (Number(order.vatAmount) || 0);
}

/** What the cart quote shows for one store: the VAT included in its goods, or null (no VAT for this store). */
export interface CartVat {
  included: number;
  ratePercent: number;
  standardGoods: number;
  zeroRatedGoods: number;
  exemptGoods: number;
}

/**
 * [cart quote] The VAT inside each approved VAT store's goods, by the same function checkout freezes with
 * (`orderVat`, the STORE-funded goods discount split across the lines). Stores whose VAT is not in effect get no entry.
 */
export async function cartVatByVendor(
  db: Pick<Prisma.TransactionClient, 'vendor'>,
  /** `storeFundedGoodsDiscount`: only the share of a discount the STORE gives (funder VENDOR); a Swift-funded promo
   *  never lowers the store's VAT (vatDiscountFor). */
  plans: ReadonlyArray<{ vendorId: string; storeFundedGoodsDiscount: number; lines: ReadonlyArray<{ id: string; amount: number; vatClass: string | null | undefined }> }>,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<Map<string, CartVat>> {
  const out = new Map<string, CartVat>();
  if (plans.length === 0) return out;
  const vendors = await db.vendor.findMany({ where: { id: { in: plans.map((p) => p.vendorId) } }, select: STORE_VAT_SELECT });
  // [STORE-VAT-EXCLUSIVE] A store pricing before VAT is priced WITH its VAT by the basket (priceBasket vatOnTop): not here.
  const effective = new Set(vendors.filter((v) => storeVatEffective(v, env, now) && !storeVatOnTop(v, env, now)).map((v) => v.id));
  for (const plan of plans) {
    if (!effective.has(plan.vendorId)) continue;
    const vat = orderVat({
      lines: plan.lines.map((l) => ({ id: l.id, amount: l.amount, vatClass: (l.vatClass === 'ZERO_RATED' || l.vatClass === 'EXEMPT' ? l.vatClass : 'STANDARD') as VatClassName })),
      goodsDiscount: plan.storeFundedGoodsDiscount,
    });
    out.set(plan.vendorId, {
      included: vat.vatAmount, ratePercent: STORE_VAT_RATE_PERCENT,
      standardGoods: vat.standardGoods, zeroRatedGoods: vat.zeroRatedGoods, exemptGoods: vat.exemptGoods,
    });
  }
  return out;
}
