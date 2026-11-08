/**
 * [owner 8 Nov 2026] "When the store says out of stock and rejects it, it should
 * tell the customer it was rejected because of out of stock, not just that it
 * cancels."
 *
 * Who closed a cancelled order, in the customer's terms (`cancellation` on the
 * customer's order list, order screen and ride screen). The server decides it,
 * because only the server can tell a store's staff from Swift support: an order's
 * `cancelledBy` is a user id (or null for the system), and that id is never sent to
 * the customer. The apps only word it (@swift/types customerCancellationWords).
 *
 * What may reach the customer as `reason`:
 * - a store's decline: the reason the store chose (its apps offer a fixed list;
 *   the API also takes typed text), as one clean line of at most 140 characters;
 * - an automatic close: the system's own words (a known code, or the customer's
 *   sentence for an unpaid-MMG close);
 * - nothing else. A customer's own note, a driver's or store's no-show record and
 *   Swift support's note are never sent here.
 *
 * Additive on every read: older apps ignore the field and keep their words.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { SYSTEM_CANCELLATION_WORDS, type CustomerCancellation } from '@swift/types';
import { NOT_COLLECTED_REASON } from './pickup-not-collected';
import { NO_SHOW_REASON } from '../booking/appointment-no-show';
import { PASSENGER_NO_SHOW_REASON } from '../rides/passenger-no-show';
import { MMG_ACCEPT_EXPIRY_REASON, mmgAcceptExpiryNotice } from './mmg-accept-expiry';

/** The reason the vendor-no-response auto-cancel writes (jobs/queue.ts autoCancelUnresponsiveOrder). */
export const VENDOR_NO_RESPONSE_REASON = 'Auto-cancelled: vendor did not respond';

/** rescue.ts records its cancellations as this actor, not a user. */
const SYSTEM_ACTOR = 'system';

/** A store's reason, as the customer reads it: one line, at most this many characters. */
export const CUSTOMER_REASON_MAX = 140;

/** The only-item-left close (picking.service cancelOnlyItemLeft) names "the customer"; the customer reads "you". */
const ONLY_ITEM_LEFT_TAIL = ' and the customer did not answer in time';

/** The no-show records a store, provider or driver makes: the customer is told it was a no-show, never the record. */
const NO_SHOW_REASONS: ReadonlySet<string> = new Set([NOT_COLLECTED_REASON, NO_SHOW_REASON, PASSENGER_NO_SHOW_REASON]);

const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);

/**
 * Text a person typed, made safe to show the customer: control, zero-width and
 * direction-override characters become spaces, runs of whitespace collapse, and
 * the line is cut at CUSTOMER_REASON_MAX. A code-shaped reason ("SOME_CODE") is
 * never shown. Null when nothing is left.
 */
export function customerSafeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || /^[A-Z0-9_]+$/.test(text)) return null;
  return text.length > CUSTOMER_REASON_MAX ? `${text.slice(0, CUSTOMER_REASON_MAX - 1).trimEnd()}…` : text;
}

/** An automatic close's reason as the customer may read it: a code this build has words for (the apps word it), or
 *  the system's own sentence. Any other code is dropped (the apps then say "This order was cancelled."). */
function systemReason(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (/^[A-Z0-9_]+$/.test(text)) return own(SYSTEM_CANCELLATION_WORDS, text) ? text : null;
  const customerVoice = text.endsWith(ONLY_ITEM_LEFT_TAIL)
    ? `${text.slice(0, -ONLY_ITEM_LEFT_TAIL.length)} and you didn’t answer in time`
    : text;
  return customerSafeReason(customerVoice);
}

export interface CancelledOrderFacts {
  status: string;
  customerId: string;
  vendorId: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  orderNumber: string;
  fulfillment?: string | null;
}

/**
 * Who closed this order, for its customer. `storeActor` answers whether the
 * user who cancelled it works for the order's store (owner or staff): see
 * storeActorKeys. Null for an order that is not CANCELLED.
 */
export function customerCancellation(
  order: CancelledOrderFacts,
  storeActor: (vendorId: string, userId: string) => boolean,
  storeName: string,
): CustomerCancellation | null {
  if (order.status !== 'CANCELLED') return null;
  const by = order.cancelledBy;
  const raw = order.cancellationReason;
  if (by != null && by === order.customerId) return { by: 'CUSTOMER', reason: null };
  if (raw != null && NO_SHOW_REASONS.has(raw)) return { by: 'NO_SHOW', reason: null };
  if (by == null || by === SYSTEM_ACTOR) {
    if (raw === VENDOR_NO_RESPONSE_REASON) return { by: 'NO_RESPONSE', reason: null };
    if (raw === MMG_ACCEPT_EXPIRY_REASON) return { by: 'SYSTEM', reason: mmgAcceptExpiryNotice(order, storeName) };
    return { by: 'SYSTEM', reason: systemReason(raw) };
  }
  if (order.vendorId && storeActor(order.vendorId, by)) return { by: 'STORE', reason: customerSafeReason(raw) };
  return { by: 'SWIFT', reason: null };
}

const storeKey = (vendorId: string, userId: string) => `${vendorId}\u0000${userId}`;

/**
 * For these cancelled orders, which (store, user) pairs are the store's own
 * people: the store's owner, or a member of its staff. Two reads, and none when
 * no order was cancelled by a person other than its customer.
 */
export async function storeActorKeys(
  prisma: PrismaClient | Prisma.TransactionClient,
  orders: ReadonlyArray<Pick<CancelledOrderFacts, 'status' | 'customerId' | 'vendorId' | 'cancelledBy'>>,
): Promise<(vendorId: string, userId: string) => boolean> {
  const pairs = orders.filter((o): o is typeof o & { vendorId: string; cancelledBy: string } =>
    o.status === 'CANCELLED' && !!o.vendorId && !!o.cancelledBy && o.cancelledBy !== SYSTEM_ACTOR && o.cancelledBy !== o.customerId);
  const known = new Set<string>();
  if (pairs.length > 0) {
    const vendorIds = [...new Set(pairs.map((p) => p.vendorId))];
    const userIds = [...new Set(pairs.map((p) => p.cancelledBy))];
    const [owners, staff] = await Promise.all([
      prisma.vendor.findMany({ where: { id: { in: vendorIds }, owner: { userId: { in: userIds } } }, select: { id: true, owner: { select: { userId: true } } } }),
      prisma.vendorStaff.findMany({ where: { vendorId: { in: vendorIds }, userId: { in: userIds } }, select: { vendorId: true, userId: true } }),
    ]);
    for (const v of owners) known.add(storeKey(v.id, v.owner.userId));
    for (const s of staff) known.add(storeKey(s.vendorId, s.userId));
  }
  return (vendorId, userId) => known.has(storeKey(vendorId, userId));
}
