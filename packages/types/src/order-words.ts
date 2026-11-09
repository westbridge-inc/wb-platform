/**
 * ONE plain-words map for what an order's system codes mean to a person
 * (UI sweep U14; COORD rulings 21 Oct 2026: web and phone never show a raw code).
 *
 * - Order statuses as a store reads them (the phone's store pill words).
 * - System cancellation reasons: the codes the server itself writes on an order
 *   (`cancellationReason`), in the server's own push wording for each reader
 *   (modules/dispatch/dispatch.service.ts, modules/dispatch/rescue.ts).
 *
 * Text a person typed (a store's reject reason, a sender's or an admin's note)
 * and the server's own sentences are kept as written. A code-shaped reason
 * (capitals, digits, underscores) never shows: a known code reads as words, an
 * unknown one as a neutral sentence.
 * Web, admin and phone all import this module from `@swift/types`.
 */
import type { OrderStatus } from './order';

type OrderStatusValue = `${OrderStatus}`;

/** A status this build has no words for. */
export const UNKNOWN_STATUS_WORDS = 'Status unavailable';

/** A cancelled order with no reason this build can put in words. */
export const ORDER_CANCELLED_WORDS = 'This order was cancelled.';

/** Every status as a store reads it. Typed by the enum: a new status without words fails to compile. */
export const STORE_ORDER_STATUS_WORDS: Readonly<Record<OrderStatusValue, string>> = {
  PENDING: 'New',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY_FOR_PICKUP: 'Ready',
  RIDER_ASSIGNED: 'Rider assigned',
  RIDER_EN_ROUTE_PICKUP: 'Rider en route',
  RIDER_ARRIVED_PICKUP: 'Rider at counter',
  PICKED_UP: 'Out for delivery',
  EN_ROUTE_DELIVERY: 'Out for delivery',
  ARRIVED: 'Out for delivery',
  DRIVER_ASSIGNED: 'Driver assigned',
  DRIVER_EN_ROUTE: 'Driver on the way',
  DRIVER_ARRIVED: 'Driver arrived',
  RIDE_IN_PROGRESS: 'Ride in progress',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  FAILED: 'Could not continue',
  RETURNING: 'Returning',
  RETURNED: 'Returned',
};

/** Older spellings the store board has always accepted. */
const STORE_STATUS_ALIASES: Readonly<Record<string, OrderStatusValue>> = {
  PLACED: 'PENDING',
  CONFIRMED: 'ACCEPTED',
  READY: 'READY_FOR_PICKUP',
};

const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);

/** A status in a store's words; a status this build does not know is "Status unavailable", never the code. */
export function storeOrderStatusWords(status: unknown): string {
  const s = typeof status === 'string' ? status.trim().toUpperCase() : '';
  const key = own(STORE_STATUS_ALIASES, s) ? STORE_STATUS_ALIASES[s]! : s;
  return own(STORE_ORDER_STATUS_WORDS, key) ? STORE_ORDER_STATUS_WORDS[key as OrderStatusValue] : UNKNOWN_STATUS_WORDS;
}

export type CancellationReader = 'customer' | 'store';

/** The codes the server writes as an order's cancellation reason, per reader. */
export const SYSTEM_CANCELLATION_WORDS: Readonly<Record<string, Readonly<Record<CancellationReader, string>>>> = {
  // dispatch.service.ts: a ride request no driver took in time ("We couldn't find you a driver").
  NO_DRIVERS_AVAILABLE: {
    customer: 'No drivers came online in time, so your request was released. Nothing to pay.',
    store: 'No driver was found in time.',
  },
  // rescue.ts: ready food no rider could collect in time ("We couldn't find a rider in time").
  FOOD_TOO_OLD: {
    customer: 'Your order was ready but no rider could be found, so it was cancelled rather than delivered cold.',
    store: 'Too old to deliver: the order was ready but no rider could be found in time.',
  },
  // rescue.ts: a parcel no rider would carry in time ("No rider for your parcel").
  NO_RIDER_FOR_PARCEL: {
    customer: 'No rider could be found for your parcel in time, so it was cancelled. You can send it again any time.',
    store: 'No rider was found for this parcel in time.',
  },
};

/**
 * [COORD ruling 8 Nov 2026 on #2412] What the customer is told when Swift support
 * cancels: one of a short fixed list, picked by the operator in the console. The
 * operator's own words are an INTERNAL note (Swift only: the audit record), never
 * sent to the customer or the store. The order records the code; every app words it.
 * `phrase` completes "Swift support cancelled this order because …"; OTHER says
 * only that Swift support cancelled it.
 * The API keeps the same list (it cannot load this package at run time):
 * apps/api/src/modules/order/customer-cancellation.ts SUPPORT_CANCELLATION_PHRASES,
 * pinned equal by customer-cancellation.unit.test.ts.
 */
export const SUPPORT_CANCELLATION_REASONS: Readonly<Record<string, Readonly<{ label: string; phrase: string | null }>>> = {
  SUPPORT_STORE_CLOSED: { label: 'The store is closed', phrase: 'the store is closed' },
  SUPPORT_ITEM_UNAVAILABLE: { label: 'An item is unavailable', phrase: 'an item is unavailable' },
  SUPPORT_DELIVERY_NOT_POSSIBLE: { label: 'Delivery is not possible', phrase: 'the delivery is not possible' },
  SUPPORT_PAYMENT_PROBLEM: { label: 'A problem with the payment', phrase: 'there is a problem with the payment' },
  SUPPORT_SAFETY: { label: 'Safety', phrase: 'of a safety concern' },
  SUPPORT_OTHER: { label: 'Other (the customer is told only that Swift support cancelled it)', phrase: null },
};

/** The sentence for a Swift support cancel with this code ("Swift support cancelled this ride because …"). Null for any
 *  other reason. Only for a close the SERVER attributed to Swift support (`cancellation.by === 'SWIFT'`), never for a
 *  raw `cancellationReason`, which a person may have typed. */
export function supportCancellationSentence(reason: unknown, noun = 'order'): string | null {
  if (typeof reason !== 'string' || !own(SUPPORT_CANCELLATION_REASONS, reason)) return null;
  const phrase = SUPPORT_CANCELLATION_REASONS[reason]!.phrase;
  return phrase ? `Swift support cancelled this ${noun} because ${phrase}.` : `Swift support cancelled this ${noun}.`;
}

/** Neutral words for a code-shaped reason this build does not know (never the code). */
export const UNKNOWN_CANCELLATION_WORDS: Readonly<Record<CancellationReader, string>> = {
  customer: ORDER_CANCELLED_WORDS,
  store: 'No further details are available.',
};

/** Code-shaped: capitals, digits and underscores only ("NO_DRIVERS_AVAILABLE"). Never shown to a person. */
const SYSTEM_CODE = /^[A-Z0-9_]+$/;

/**
 * The cancellation reason in words for this reader. A known system code reads
 * as words, an unknown code-shaped reason as UNKNOWN_CANCELLATION_WORDS, and
 * any other text (typed by a store, a sender or an admin, or one of the
 * server's own sentences) is kept as written. Null only when there is no reason.
 */
export function cancellationReasonWords(reason: unknown, reader: CancellationReader): string | null {
  if (typeof reason !== 'string') return null;
  const text = reason.trim();
  if (!text) return null;
  if (own(SYSTEM_CANCELLATION_WORDS, text)) return SYSTEM_CANCELLATION_WORDS[text]![reader];
  // [#2412 security review] A SUPPORT_… code is never read out here: this reason has no decided author, and a
  // store, a customer or a sender must not be able to type one and read as Swift support. Its words are given only
  // where the server decided Swift support closed it (customerCancellationWords, by SWIFT).
  return SYSTEM_CODE.test(text) ? UNKNOWN_CANCELLATION_WORDS[reader] : text;
}
