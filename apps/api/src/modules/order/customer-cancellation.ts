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
import type { CustomerCancellation } from '@swift/types';
import { NOT_COLLECTED_REASON } from './pickup-not-collected';
import { NO_SHOW_REASON } from '../booking/appointment-no-show';
import { PASSENGER_NO_SHOW_REASON } from '../rides/passenger-no-show';
import { MMG_ACCEPT_EXPIRY_REASON, mmgAcceptExpiryNotice } from './mmg-accept-expiry';
import { consoleRoleOf } from '../auth/console-role';

/** The reason the vendor-no-response auto-cancel writes (jobs/queue.ts autoCancelUnresponsiveOrder). */
export const VENDOR_NO_RESPONSE_REASON = 'Auto-cancelled: vendor did not respond';

/**
 * The automatic-close codes the apps have words for (the keys of @swift/types
 * SYSTEM_CANCELLATION_WORDS). Listed here because the compiled API can load only
 * TYPES from @swift/types (it ships TypeScript source; a value import crashes the
 * API at boot: runtime-package-imports.unit.test.ts). customer-cancellation.unit.test.ts
 * pins this list to the apps' map, so a code added there must be added here.
 */
export const SYSTEM_CANCELLATION_CODES: ReadonlySet<string> = new Set(['NO_DRIVERS_AVAILABLE', 'FOOD_TOO_OLD', 'NO_RIDER_FOR_PARCEL']);

/** rescue.ts records its cancellations as this actor, not a user. */
const SYSTEM_ACTOR = 'system';

/** A store's reason, as the customer reads it: one line, at most this many characters. */
export const CUSTOMER_REASON_MAX = 140;

/** The no-show records a store, provider or driver makes: the customer is told it was a no-show, never the record. */
const NO_SHOW_REASONS: ReadonlySet<string> = new Set([NOT_COLLECTED_REASON, NO_SHOW_REASON, PASSENGER_NO_SHOW_REASON]);

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
  if (SYSTEM_CANCELLATION_CODES.has(text)) return text;
  const onlyItem = ONLY_ITEM_LEFT.exec(text);
  if (onlyItem) return customerSafeReason(`Out of stock: ${onlyItem[1]} was the only item and you didn’t answer in time`);
  return null;
}

export interface CancelledOrderFacts {
  id: string;
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
 * What tells the people behind an order apart, read once for a page (see
 * orderPeople). Swift support is recognised from DURABLE evidence first: the
 * append-only audit row its console writes in the same commit as the action.
 */
export interface OrderPeople {
  /** Swift support closed this order: its cancel (CANCEL_ORDER) or its MMG "refund handled by the store" close, by this person. */
  closedBySwift(orderId: string, userId: string): boolean;
  /** This person acted on this order from Swift's console (any audited console action), or holds a console role today. */
  actedAsSwift(orderId: string, userId: string): boolean;
  /** This person owns the store or is one of its staff today. */
  storeMember(vendorId: string, userId: string): boolean;
  /** This person holds a Swift console role today (ADMIN or SUPER_ADMIN, read as the console reads it). */
  consoleStaff(userId: string): boolean;
}

/** Nobody known: every check false (a page with no person to look up). */
export const NO_ORDER_PEOPLE: OrderPeople = {
  closedBySwift: () => false,
  actedAsSwift: () => false,
  storeMember: () => false,
  consoleStaff: () => false,
};

/**
 * Who closed this order, for its customer. Null for an order that is not CANCELLED.
 *
 * A person other than the customer, in this order:
 * 1. Swift support's own audit row for this close (admin cancel, MMG store close) → SWIFT.
 *    Durable: a support person who later loses the console role is still Swift.
 * 2. The store's owner or one of its staff → STORE, with the store's reason. Checked
 *    before the console role, so a store person who also holds a console role and
 *    declines from the store's side is the store.
 * 3. A console role today, or the operator's default reason → SWIFT.
 * 4. Anyone else on a store order → STORE: store people come and go (a staff member
 *    removed, an account deleted), and a past decline must not turn into Swift's.
 * 5. A ride or a parcel has no store: anyone else is Swift support.
 */
export function customerCancellation(
  order: CancelledOrderFacts,
  people: OrderPeople,
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
  if (people.closedBySwift(order.id, by)) return { by: 'SWIFT', reason: null };
  if (order.vendorId && people.storeMember(order.vendorId, by)) return { by: 'STORE', reason: customerSafeReason(raw) };
  if (people.consoleStaff(by) || raw === ADMIN_CANCEL_DEFAULT_REASON) return { by: 'SWIFT', reason: null };
  if (order.vendorId) return { by: 'STORE', reason: customerSafeReason(raw) };
  // A ride or a parcel has no store; the only other person who closes one is Swift support.
  return { by: 'SWIFT', reason: null };
}

/** The console actions that close an order as Swift support (audit `action`; admin.routes, mmg-store-close). */
function isSwiftCloseAction(action: string): boolean {
  return action === 'CANCEL_ORDER'
    || action === 'ADMIN PUT /api/v1/admin/orders/:id/cancel'
    || action === 'ADMIN POST /api/v1/admin/orders/:id/close-store-refund';
}

/** A person, not the system: the system writes null, 'system' or 'system:<what>'. */
const isPerson = (id: string | null | undefined): id is string => !!id && id !== SYSTEM_ACTOR && !id.startsWith('system:');

type PeopleOrder = Pick<CancelledOrderFacts, 'id' | 'status' | 'customerId' | 'cancelledBy' | 'vendorId'> & {
  statusHistory?: ReadonlyArray<{ changedBy: string | null }>;
};

/**
 * The people behind these orders, for orderPeople's checks: whoever cancelled one
 * (other than its customer) and, where the status history is given, whoever wrote a
 * step of it. One read of each kind for the page; none when there is nobody to look up.
 */
export async function orderPeople(
  prisma: PrismaClient | Prisma.TransactionClient,
  orders: ReadonlyArray<PeopleOrder>,
): Promise<OrderPeople> {
  const cancellers = orders.filter((o) => o.status === 'CANCELLED' && isPerson(o.cancelledBy) && o.cancelledBy !== o.customerId);
  const writers = orders.flatMap((o) => (o.statusHistory ?? []).map((row) => row.changedBy).filter((id): id is string => isPerson(id) && id !== o.customerId));
  const ids = [...new Set([...cancellers.map((o) => o.cancelledBy as string), ...writers])];
  if (ids.length === 0) return NO_ORDER_PEOPLE;
  const orderIds = [...new Set(orders.map((o) => o.id))];
  // Membership is asked only for the cancellers of store orders (the one place it decides anything).
  const vendorIds = [...new Set(cancellers.map((o) => o.vendorId).filter((v): v is string => !!v))];
  const cancellerIds = [...new Set(cancellers.map((o) => o.cancelledBy as string))];
  const [users, audits, owners, staff] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, roles: true } }),
    prisma.auditLog.findMany({
      where: { entityId: { in: orderIds }, userId: { in: ids }, OR: [{ action: 'CANCEL_ORDER' }, { action: { startsWith: 'ADMIN ' } }] },
      select: { entityId: true, userId: true, action: true },
    }),
    vendorIds.length > 0 ? prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, owner: { select: { userId: true } } } }) : [],
    vendorIds.length > 0 ? prisma.vendorStaff.findMany({ where: { vendorId: { in: vendorIds }, userId: { in: cancellerIds } }, select: { vendorId: true, userId: true } }) : [],
  ]);
  const consoleIds = new Set(users.filter((u) => consoleRoleOf(u.roles)).map((u) => u.id));
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  const closed = new Set<string>();
  const acted = new Set<string>();
  for (const row of audits) {
    if (!row.userId) continue;
    acted.add(key(row.entityId, row.userId));
    if (isSwiftCloseAction(row.action)) closed.add(key(row.entityId, row.userId));
  }
  const members = new Set<string>([
    ...owners.flatMap((v) => (v.owner?.userId ? [key(v.id, v.owner.userId)] : [])),
    ...staff.map((s) => key(s.vendorId, s.userId)),
  ]);
  return {
    closedBySwift: (orderId, userId) => closed.has(key(orderId, userId)),
    actedAsSwift: (orderId, userId) => consoleIds.has(userId) || acted.has(key(orderId, userId)),
    storeMember: (vendorId, userId) => members.has(key(vendorId, userId)),
    consoleStaff: (userId) => consoleIds.has(userId),
  };
}

/**
 * The note a customer may read on the CANCELLED step of the order's history: the
 * same words as `cancellation.reason` when they are words (the store's cleaned
 * reason, or the system's own sentence), and nothing otherwise (Swift support's
 * note, the customer's own note, a no-show record, a code the apps word).
 */
export function customerCancelledStepNote(cancellation: CustomerCancellation | null): string | null {
  const reason = cancellation?.reason ?? null;
  if (!reason || cancellation?.by === 'SWIFT') return null;
  return /^[A-Z0-9_]+$/.test(reason) ? null : reason;
}

/**
 * A step of the order's status history as its customer may read it: never who wrote
 * it (a user id), never a note Swift support wrote (its audited console actions, or
 * anyone holding a console role), and the CANCELLED step says only what
 * customerCancelledStepNote allows. The position evidence is cut by the caller's own
 * projection (withoutPositionEvidence).
 */
export function customerStepNote(
  order: Pick<CancelledOrderFacts, 'id' | 'customerId'>,
  row: { status: string; note: string | null; changedBy: string | null },
  people: OrderPeople,
  cancellation: CustomerCancellation | null,
): string | null {
  if (row.status === 'CANCELLED') return customerCancelledStepNote(cancellation);
  if (isPerson(row.changedBy) && row.changedBy !== order.customerId && people.actedAsSwift(order.id, row.changedBy)) return null;
  return row.note;
}

/**
 * A whole order row, as its customer (or a parcel's sender) may read it: `cancelledBy`
 * (a user id) removed, the raw `cancellationReason` blanked when Swift support closed
 * it, and `cancellation` added (who closed it, in the customer's words). Every other
 * field is the caller's. Additive for older apps: none reads `cancelledBy`.
 */
export function senderCancellationView<Row extends CancelledOrderFacts>(
  order: Row,
  people: OrderPeople,
  storeName = 'The store',
): Omit<Row, 'cancelledBy'> & { cancellation: CustomerCancellation | null } {
  const cancellation = customerCancellation(order, people, storeName);
  const rest = (({ cancelledBy: _cancelledBy, ...others }: Row) => others)(order);
  return { ...rest, cancellationReason: cancellation?.by === 'SWIFT' ? null : order.cancellationReason, cancellation };
}
