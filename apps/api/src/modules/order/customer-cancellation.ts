/**
 * [owner 8 Nov 2026] "When the store says out of stock and rejects it, it should
 * tell the customer it was rejected because of out of stock, not just that it
 * cancels."
 *
 * Who closed a cancelled order, in the customer's terms (`cancellation` on the
 * customer's order list, order screen and ride screen). The server decides it,
 * because only the server can tell a store's people from Swift support: an order's
 * `cancelledBy` is a user id (or null for the system), and that id is never sent to
 * the customer. The apps only word it (@swift/types customerCancellationWords).
 *
 * What may reach the customer as `reason`:
 * - a store's decline: the reason the store chose (its apps offer a fixed list;
 *   the API also takes typed text), as one clean line of at most 140 characters;
 * - an automatic close: only the system's own known words (a code with words, the
 *   only-item-left sentence, or the customer's sentence for an unpaid-MMG close);
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
import { consoleRoleOf } from '../auth/console-role';

/** The reason the vendor-no-response auto-cancel writes (jobs/queue.ts autoCancelUnresponsiveOrder). */
export const VENDOR_NO_RESPONSE_REASON = 'Auto-cancelled: vendor did not respond';

/** rescue.ts records its cancellations as this actor, not a user. */
const SYSTEM_ACTOR = 'system';

/** A store's reason, as the customer reads it: one line, at most this many characters. */
export const CUSTOMER_REASON_MAX = 140;

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

/** The only-item-left close (picking.service cancelOnlyItemLeft), whose words name the item and "the customer". */
const ONLY_ITEM_LEFT = /^Out of stock: (.{1,120}) was the only item and the customer did not answer in time$/;

/**
 * An automatic close's reason as the customer may read it. Only the system's own
 * known words get through: a code this build has words for (the apps word it), or
 * the only-item-left sentence, spoken to the customer ("you"). Anything else is
 * dropped, and the apps say "This order was cancelled.".
 */
function systemReason(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (own(SYSTEM_CANCELLATION_WORDS, text)) return text;
  const onlyItem = ONLY_ITEM_LEFT.exec(text);
  if (onlyItem) return customerSafeReason(`Out of stock: ${onlyItem[1]} was the only item and you didn’t answer in time`);
  return null;
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

/** The reason Swift support's cancel records when the operator gives none (admin.routes PUT /orders/:id/cancel). */
export const ADMIN_CANCEL_DEFAULT_REASON = 'Cancelled by admin';

/**
 * Who closed this order, for its customer. `isSwiftStaff` answers whether the
 * user who cancelled it holds a Swift console role (see swiftStaffIds). Null for
 * an order that is not CANCELLED.
 *
 * Swift is recognised POSITIVELY (the canceller's console role, or the operator's
 * default reason); on a store order every other person who is not the customer
 * is the store. Store people come and go (a staff member removed, an account
 * deleted, a partner wound down), and a past decline must not turn into "Cancelled
 * by Swift" when they do.
 */
export function customerCancellation(
  order: CancelledOrderFacts,
  isSwiftStaff: (userId: string) => boolean,
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
  if (isSwiftStaff(by) || raw === ADMIN_CANCEL_DEFAULT_REASON) return { by: 'SWIFT', reason: null };
  if (order.vendorId) return { by: 'STORE', reason: customerSafeReason(raw) };
  // A ride or a parcel has no store; the only other person who closes one is Swift support.
  return { by: 'SWIFT', reason: null };
}

/**
 * Which of the people who cancelled these orders hold a Swift console role
 * (ADMIN or SUPER_ADMIN, read as the console reads it: auth/console-role.ts).
 * One read for the page, and none when no order was cancelled by a person other
 * than its customer.
 */
export async function swiftStaffIds(
  prisma: PrismaClient | Prisma.TransactionClient,
  orders: ReadonlyArray<Pick<CancelledOrderFacts, 'status' | 'customerId' | 'cancelledBy'>>,
): Promise<(userId: string) => boolean> {
  const ids = [...new Set(orders
    .filter((o) => o.status === 'CANCELLED' && !!o.cancelledBy && o.cancelledBy !== SYSTEM_ACTOR && o.cancelledBy !== o.customerId)
    .map((o) => o.cancelledBy as string))];
  const staff = new Set<string>();
  if (ids.length > 0) {
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, roles: true } });
    for (const u of users) if (consoleRoleOf(u.roles)) staff.add(u.id);
  }
  return (userId) => staff.has(userId);
}
