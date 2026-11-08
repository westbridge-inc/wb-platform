/**
 * [OOS-FLOW · owner 8 Nov 2026] An item out of stock AFTER the store accepted: the shared (phone + web)
 * rules and words. Kept out of storeOrderRules.ts on purpose: every web dashboard page loads that file
 * (the new-order takeover), and these are only for the order screen (perf budget).
 */

type OrderLike = { status?: unknown; items?: unknown } | null | undefined;
type LineLike = { subStatus?: unknown } | null | undefined;

const linesOf = (order: OrderLike): LineLike[] => (Array.isArray(order?.items) ? (order!.items as LineLike[]) : []);
const waiting = (order: OrderLike) => ['PENDING', 'PLACED'].includes(String(order?.status ?? '').toUpperCase());

const REMOVED = (l: LineLike) => l?.subStatus === 'REFUNDED' || l?.subStatus === 'REJECTED';
const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'RETURNED'];
/** The stages a store may still reject from (the server's STORE_REJECTABLE_STATUSES; PLACED/CONFIRMED are old names). */
const STORE_REJECTABLE = ['PENDING', 'PLACED', 'ACCEPTED', 'CONFIRMED', 'PREPARING'];

/**
 * [OOS-FLOW · owner 8 Nov 2026] After the store accepted: is this line the last item still coming (every
 * other line came off)? Removing it ends the order as the store's decline "Out of stock" (the server does
 * it in one step, so the store is asked once first, and told). A swap is still offered on it.
 */
export function lastItemAfterAccept(order: OrderLike, line: LineLike): boolean {
  if (waiting(order) || REMOVED(line)) return false;
  const coming = linesOf(order).filter((l) => !REMOVED(l));
  return coming.length === 1 && coming[0] === line;
}

/**
 * [OOS-FLOW] An accepted order whose every item came off before the server ended such orders itself
 * (an order emptied on an older server). Nothing can be handed over: Ready is refused. The store
 * rejects it "Out of stock" while it still can, or asks Swift support.
 */
export function nothingLeftToHandOver(order: OrderLike): boolean {
  const s = String(order?.status ?? '').toUpperCase();
  if (waiting(order) || TERMINAL.includes(s)) return false;
  const lines = linesOf(order);
  return lines.length > 0 && lines.every(REMOVED);
}

/** [OOS-FLOW] The store may still reject this order itself (else only Swift support closes it). */
export function storeCanReject(order: OrderLike): boolean {
  return STORE_REJECTABLE.includes(String(order?.status ?? '').toUpperCase());
}

/** The store's words for it, phone and web alike. */
export const ACCEPTED_OUT_OF_STOCK_WORDS = {
  // The line's "Out of stock?" offers both ways, by name.
  menuTitle: 'Out of stock — remove it, or offer a replacement:',
  removeItem: 'Remove item',
  offerTitle: 'Offer a replacement (the customer approves or declines in the app):',
  noReplacement: 'No similar item in stock in this section.',
  showAll: 'Show all items',
  // The last item still coming: removing it ends the order, asked once.
  lastRemoveAsk: 'This is the last item on the order. Removing it cancels the order as out of stock, and the customer is told right away. You can offer a replacement instead.',
  lastRemoveYes: 'Remove and cancel the order',
  lastRemoveKeep: 'Keep it',
  orderEnded: 'The order was cancelled as out of stock. The customer has been told.',
  // An order emptied on an older server.
  emptied: 'Every item on this order came off as out of stock, so there is nothing to hand over. Reject it with the reason “Out of stock”: the customer is told right away.',
  emptiedSupport: 'Every item on this order came off as out of stock, so there is nothing to hand over. Contact Swift support to close it.',
  emptiedButton: 'Reject: out of stock',
} as const;
