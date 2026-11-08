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
  return SYSTEM_CODE.test(text) ? UNKNOWN_CANCELLATION_WORDS[reader] : text;
}

// ---------------------------------------------------------------------------
// [owner 8 Nov 2026] "When the store says out of stock and rejects it, it should
// tell the customer it was rejected because of out of stock, not just that it
// cancels." Who closed a cancelled order, as the customer's apps are told.
// ---------------------------------------------------------------------------

/**
 * Who closed a cancelled order, in the customer's terms. The server decides it
 * (it alone can tell a store's staff from Swift support); every customer app
 * only words it.
 * - CUSTOMER: the customer cancelled it.
 * - STORE: the store (or, for a booking, the provider) declined it.
 * - NO_RESPONSE: the store or provider never answered in time.
 * - NO_SHOW: the store, provider or driver recorded that the customer did not come.
 * - SWIFT: Swift support closed it.
 * - SYSTEM: Swift closed it automatically (no driver, no rider, an MMG payment never confirmed…).
 */
export const CUSTOMER_CANCELLED_BY = ['CUSTOMER', 'STORE', 'NO_RESPONSE', 'NO_SHOW', 'SWIFT', 'SYSTEM'] as const;
export type CustomerCancelledBy = (typeof CUSTOMER_CANCELLED_BY)[number];

/** The `cancellation` a customer's order carries once it is CANCELLED (null otherwise). `reason` is already in the
 *  customer's words: the store's own chosen reason when the store declined, the system's words for an automatic
 *  close, and null when there is nothing more to say (Swift support's own notes are never sent). */
export interface CustomerCancellation {
  by: CustomerCancelledBy;
  reason: string | null;
}

/** Read a `cancellation` off the wire: anything that is not one of the known shapes is null (an older server, or a party this build has no words for). */
export function parseCustomerCancellation(value: unknown): CustomerCancellation | null {
  if (!value || typeof value !== 'object') return null;
  const by = (value as { by?: unknown }).by;
  if (typeof by !== 'string' || !(CUSTOMER_CANCELLED_BY as readonly string[]).includes(by)) return null;
  const raw = (value as { reason?: unknown }).reason;
  const reason = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  return { by: by as CustomerCancelledBy, reason };
}

/** What a customer's order is, for the words: a ride, a parcel request, a booking or an order. */
export interface CustomerCancellationFacts {
  status?: unknown;
  orderType?: unknown;
  fulfillment?: unknown;
  paymentMethod?: unknown;
  paymentStatus?: unknown;
  cancellation?: unknown;
}

export interface CustomerCancellationWords {
  /** The short line for a list row ("Declined by store · Out of stock"). */
  label: string;
  /** The sentence for the order's own screen ("The store declined your order: Out of stock."). */
  headline: string;
  /** What happens to the money, only where it is certainly true; null when there is nothing true to add. */
  money: string | null;
}

const sentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** The labels of the system closes this build can name; any other is plain "Cancelled". */
const SYSTEM_CANCELLATION_LABELS: Readonly<Record<string, string>> = {
  NO_DRIVERS_AVAILABLE: 'No driver found',
  FOOD_TOO_OLD: 'No rider found',
  NO_RIDER_FOR_PARCEL: 'No rider found',
};

/**
 * The words for a cancelled order, by who closed it. Null when the order is not
 * CANCELLED or the server sent no `cancellation` this build can read: the caller
 * keeps its own words (an older server).
 *
 * The money line is only ever what is certainly true (see `money` below). Any
 * payment state it does not name (paid by MMG, refunded, a ride or a parcel) adds
 * nothing here: the order's own refund card says what is owed.
 */
export function customerCancellationWords(order: CustomerCancellationFacts | null | undefined): CustomerCancellationWords | null {
  if (!order || order.status !== 'CANCELLED') return null;
  const cancellation = parseCustomerCancellation(order.cancellation);
  if (!cancellation) return null;
  const ride = order.orderType === 'TAXI';
  const parcel = order.orderType === 'COURIER';
  const booking = !ride && !parcel && order.fulfillment === 'APPOINTMENT';
  const noun = ride ? 'ride' : parcel ? 'request' : booking ? 'booking' : 'order';
  const party = booking ? 'provider' : 'store';
  const Party = booking ? 'Provider' : 'Store';
  const { by, reason } = cancellation;

  // A ride or a parcel is paid to its driver or rider at the end, and a no-show is the store's or driver's record:
  // no money words. Cash on a store order is paid at the door or the counter, and every close but Swift support's
  // happens before that (a store declines while PENDING, ACCEPTED or PREPARING; a customer cancels before handover;
  // the system closes a waiting order), so it was never charged. Swift support may close an order at any stage, so
  // its cash close says nothing. MMG still waiting for the store's "Paid by MMG" may already have been sent: the
  // store refunds it directly (the push says the same). Paid MMG is never declined by a store (the API refuses it).
  const money = (): string | null => {
    if (ride || parcel || by === 'NO_SHOW') return null;
    if (order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'PENDING') {
      return `If you already sent the MMG payment, the ${party} refunds you directly.`;
    }
    // Cash still marked unpaid: nothing was collected (a recorded collection would say otherwise).
    if (order.paymentMethod === 'CASH' && order.paymentStatus === 'PENDING' && by !== 'SWIFT') return 'You weren’t charged.';
    return null;
  };

  switch (by) {
    case 'STORE':
      return {
        label: reason ? `Declined by ${party} · ${reason}` : `Declined by ${party}`,
        headline: reason ? sentence(`The ${party} declined your ${noun}: ${reason}`) : `The ${party} declined your ${noun}.`,
        money: money(),
      };
    case 'NO_RESPONSE':
      return {
        label: `${Party} didn’t respond`,
        headline: `The ${party} didn’t respond in time, so your ${noun} was cancelled.`,
        money: money(),
      };
    case 'CUSTOMER':
      return { label: 'Cancelled by you', headline: `You cancelled this ${noun}.`, money: money() };
    case 'NO_SHOW':
      return ride
        ? { label: 'Marked as a no-show', headline: 'The driver recorded that you didn’t come to the pickup, so the ride was cancelled.', money: null }
        : booking
          ? { label: 'Marked as missed', headline: 'The provider recorded that you didn’t come, so the booking was closed.', money: null }
          : { label: 'Not collected', headline: 'The store recorded that this order wasn’t collected, so it was closed.', money: null };
    case 'SWIFT':
      return { label: 'Cancelled by Swift', headline: `Swift support cancelled this ${noun}.`, money: money() };
    case 'SYSTEM': {
      const code = typeof reason === 'string' ? reason : '';
      return {
        label: own(SYSTEM_CANCELLATION_LABELS, code) ? SYSTEM_CANCELLATION_LABELS[code]! : 'Cancelled',
        headline: cancellationReasonWords(reason, 'customer') ?? `This ${noun} was cancelled.`,
        money: money(),
      };
    }
    default:
      return null;
  }
}
