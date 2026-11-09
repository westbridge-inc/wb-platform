/**
 * [OOS-FLOW · owner 8 Nov 2026] An item out of stock AFTER the store accepted: the shared (phone + web)
 * rules and words. Kept out of storeOrderRules.ts on purpose: every web dashboard page loads that file
 * (the new-order takeover), and these are only for the order screen (perf budget).
 */

import { MMG_MONEY_MOVED } from './storeOrderRules';

type OrderLike = { status?: unknown; items?: unknown; paymentMethod?: unknown; paymentStatus?: unknown; outOfStockEndsOrder?: unknown } | null | undefined;
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

const mmgPaid = (order: OrderLike) =>
  order?.paymentMethod === 'MOBILE_MONEY' && (MMG_MONEY_MOVED as readonly unknown[]).includes(order?.paymentStatus);

/** [OOS-FLOW] The store may still reject this order itself (else only Swift support closes it).
 *  [REVIEW-2 F7] An MMG order already paid is closed by Swift support, never by an in-app Reject. */
export function storeCanReject(order: OrderLike): boolean {
  return STORE_REJECTABLE.includes(String(order?.status ?? '').toUpperCase()) && !mmgPaid(order);
}

/**
 * [OOS-FLOW · REVIEW-2 F2] The server this order came from ends an accepted order whose last item comes off
 * (it says so on the order: outOfStockEndsOrder). Only then does the app ask "remove and cancel the order?",
 * send the confirmation, and word a swap's wait as a cancellation: an app update that reaches phones before
 * that server never promises a cancellation that will not happen.
 */
export function serverEndsOrderOnLastItem(order: OrderLike): boolean {
  return order?.outOfStockEndsOrder === true;
}

/** [OOS-FLOW] Removing this line cancels the order: the store is asked once, and the removal says so. */
export function removalEndsOrder(order: OrderLike, line: LineLike): boolean {
  return serverEndsOrderOnLastItem(order) && lastItemAfterAccept(order, line);
}

/**
 * [OOS-FLOW · REVIEW-2 F9] The server's rule for taking an item off an MMG order (phone and web alike): its total
 * cannot change in the app, so a line never comes off; the LAST item may (that cancels the order) while the
 * payment has not moved yet. True = the store settles it with the customer directly instead.
 */
export function mmgRemovalLocked(order: OrderLike, line: LineLike): boolean {
  if (order?.paymentMethod !== 'MOBILE_MONEY') return false;
  return !(removalEndsOrder(order, line) && !mmgPaid(order));
}

/** [OOS-FLOW · REVIEW-1 S3-2] The server's answer to a removal sent without the store's confirmation, because it
 *  was the last item still coming (another device took the other one off): the app asks instead. */
export const LAST_ITEM_ENDS_ORDER = 'LAST_ITEM_ENDS_ORDER';

/** The server's error code on a refused request (axios or fetch shapes), or undefined. */
export function serverErrorCode(error: unknown): string | undefined {
  const e = error as { response?: { data?: { error?: { code?: unknown } } }; code?: unknown } | null | undefined;
  const code = e?.response?.data?.error?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
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
  /** [REVIEW-2 F9] An MMG line cannot come off in the app (its total cannot change there). */
  mmgLocked: 'MMG order — settle item changes with the customer directly.',
  /** [REVIEW-2 F1] A swap's wait on the only item left (not MMG): no answer cancels the order. */
  lastItemWait: (at: string) => `No answer by ${at} cancels the order: it is the only item left.`,
  /** [REVIEW-2 F9] "Show all items" shows at most this many: it says so when there are more. */
  showingSome: (shown: number, total: number) => `Showing ${shown} of ${total} items in stock.`,
} as const;

/** [REVIEW-2 F9] How many replacements "Show all items" lists at once. */
export const SHOW_ALL_LIMIT = 24;
