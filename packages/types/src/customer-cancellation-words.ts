/**
 * Who closed a cancelled order, in the customer's words (customer order list,
 * order screen and ride screen on the phone and the web).
 *
 * Imported by PATH ('@swift/types/src/customer-cancellation-words'), never
 * through the package index (which re-exports its types only): the store
 * console's pages load that index, and these customer-only words must not grow
 * what they download (apps/web perf budget; the same rule as evidence-reference.ts).
 * The compiled API cannot load this source-only package at run time; it keeps
 * its list of system codes in apps/api/src/modules/order/customer-cancellation.ts,
 * pinned to SYSTEM_CANCELLATION_WORDS by customer-cancellation.unit.test.ts.
 */
import { cancellationReasonWords, supportCancellationSentence } from './order-words';

const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);

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
      // [COORD ruling 8 Nov 2026] The reason Swift support picked for the customer (a fixed list), never its own note.
      return { label: 'Cancelled by Swift', headline: supportCancellationSentence(reason, noun) ?? `Swift support cancelled this ${noun}.`, money: money() };
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
