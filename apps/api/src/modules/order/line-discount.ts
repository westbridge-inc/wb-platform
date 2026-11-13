import { allocateAcrossLines, percentageOf, promoDiscount } from '../../utils/order-total';

/**
 * [Audit FABLE-01 A-1 · Review A S3-1 on #2500] What a promo's discount becomes when one line of a discounted order
 * changes at picking: it comes off (out of stock, "continue without", a declined swap, no answer) or it is swapped for
 * a substitute at another price. ONE rule for both, read by the change itself (picking.service.ts, inside the order
 * lock) and by the customer's order screen (substitution-view.ts), so what is shown is what is charged.
 *  - A percentage code is re-priced on the goods after the change, under its own cap, never above what was given,
 *    and gives back at most its rate on the change itself [Review B S3-2].
 *  - A fixed-amount code stays applied but shrinks in proportion to the goods after the change, never above what was
 *    given [owner ruling 13 Nov 2026, superseding R2's "kept whole"].
 *  - With no redemption record (an order placed before M-32) the discount is read as billing reads it
 *    (sales-components.ts): goods first, up to the goods; anything above the goods was the delivery fee's and never
 *    moves with a line [Review A N-3].
 * Never more than the discount left; the discount never grows. `amount` is how much the order's discount shrinks.
 */
export type LineDiscountRedemption = { goodsDiscount: unknown; lineAllocations: unknown; discountType: string; discountValue: unknown; maxDiscount: unknown };
export type LineDiscountChange = { lineId: string; newLineTotal: number };

export function lineChangeDiscount(input: {
  orderDiscount: unknown;
  /** The lines still carrying money BEFORE the change (not REFUNDED or REJECTED), with their totals. */
  live: ReadonlyArray<{ id: string; amount: number }>;
  change: LineDiscountChange;
  redemption: LineDiscountRedemption | null | undefined;
}): { amount: number; redemption: { goodsDiscount: number; lineAllocations?: Array<Record<string, unknown>> } | null } {
  const left = Math.max(0, Number(input.orderDiscount) || 0);
  if (left <= 0) return { amount: 0, redemption: null };
  const before = input.live.map((l) => ({ id: l.id, amount: Math.max(0, l.amount) }));
  const after = before
    .map((l) => (l.id === input.change.lineId ? { id: l.id, amount: Math.max(0, input.change.newLineTotal) } : l))
    .filter((l) => l.id !== input.change.lineId || l.amount > 0);
  const goodsBefore = before.reduce((sum, l) => sum + l.amount, 0);
  const goodsAfter = after.reduce((sum, l) => sum + l.amount, 0);
  const shrink = (pool: number) => (goodsBefore > 0 ? Math.round((pool * goodsAfter) / goodsBefore) : 0);
  if (!input.redemption) {
    const goodsPart = Math.min(left, goodsBefore);
    return { amount: Math.max(0, goodsPart - Math.min(goodsPart, shrink(goodsPart))), redemption: null };
  }
  const r = input.redemption;
  const goods = Math.max(0, Number(r.goodsDiscount) || 0);
  const repriced = r.discountType === 'PERCENTAGE'
    ? promoDiscount({ discountType: 'PERCENTAGE', discountValue: r.discountValue, maxDiscount: r.maxDiscount }, { subtotal: goodsAfter, deliveryFee: 0 })
    : shrink(goods);
  const newGoods = Math.max(0, Math.min(goods, goodsAfter, repriced));
  // [Review B S3-2] A percentage code gives back at most its rate on the change itself: an order carrying more than
  // its own rate (a multi-store basket's discount is spread greedily, cart-plans) never hands its surplus to one line,
  // and a same-price or dearer swap gives nothing back.
  const rateCap = r.discountType === 'PERCENTAGE' ? percentageOf(Math.max(0, goodsBefore - goodsAfter), r.discountValue) : Number.POSITIVE_INFINITY;
  const amount = Math.min(left, goods - newGoods, rateCap);
  const shares = new Map(allocateAcrossLines(goods - amount, after).map((a) => [a.id, a.share] as const));
  const allocations = Array.isArray(r.lineAllocations) ? (r.lineAllocations as Array<Record<string, unknown>>) : null;
  return {
    amount,
    redemption: {
      goodsDiscount: goods - amount,
      // The lines still coming own the goods discount left, summing to it exactly; a line that is off owns none.
      ...(allocations ? { lineAllocations: allocations.map((a) => ({ ...a, goods: typeof a?.['orderItemId'] === 'string' ? shares.get(a['orderItemId'] as string) ?? 0 : 0 })) } : {}),
    },
  };
}
