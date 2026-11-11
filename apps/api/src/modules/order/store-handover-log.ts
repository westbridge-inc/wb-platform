import type { OrderStatus, Prisma } from '@prisma/client';

/** [O-2 · owner 22 Oct 2026] The status-log note of the store's one-tap "Handed to rider". The row
 *  carries the order's status at the tap (READY_FOR_PICKUP or a rider pre-custody status): it is
 *  evidence, not a transition. */
export const HANDED_TO_RIDER_NOTE = 'Handed to the rider by the store';

/** [O-2] The status-log note of a takeaway handed over with no code on a store whose code is off. It
 *  states only what the server knows (REVIEW-F S3-1 on #2055): no code was asked for. */
export const NO_CODE_HANDOVER_NOTE = "Handed to the customer without a pickup code (the store's code is off)";

/** [FOLLOWUPS 11 Nov 2026] The status-log notes of the store's kitchen steps taken AFTER a Swift rider
 *  took the order (vendor.routes recordPrepProgress). The rider owns the status lane then, so the row
 *  carries the rider's status at the tap (RIDER_ASSIGNED, RIDER_EN_ROUTE_PICKUP or RIDER_ARRIVED_PICKUP):
 *  evidence of the kitchen, not a rider step. */
export const STORE_PREPARING_WITH_RIDER_NOTE = 'Vendor started preparing (rider already assigned)';
export const STORE_READY_WITH_RIDER_NOTE = 'Order ready for pickup (rider already assigned)';

/**
 * [FOLLOWUPS 11 Nov 2026 · production rider test: 6 of 13 orders "logged the same rider step 2-3
 * times"] The store's rows written at the order's CURRENT status while a rider holds it: the kitchen
 * steps above and "Handed to rider". They are append-only evidence and stay in the log; they are
 * never a rider step. Every reader that counts or times a rider step (assignment episodes, the
 * pickup-overdue clock, the handed-to-rider episode, the customer's and the store's timelines)
 * leaves them out through this ONE list, so none of them reads a store tap as a repeated step.
 */
export const STORE_EVIDENCE_NOTES: readonly string[] = [HANDED_TO_RIDER_NOTE, STORE_PREPARING_WITH_RIDER_NOTE, STORE_READY_WITH_RIDER_NOTE];

/** True for a store evidence row (above): a store tap at the rider's status, never a rider step. */
export function isStoreEvidenceRow(row: { note: string | null }): boolean {
  return row.note != null && STORE_EVIDENCE_NOTES.includes(row.note);
}

/** The where-clause half that keeps only the rows that ARE steps (`note` is nullable: a bare `notIn`
 *  would also drop rows with no note). */
export function notStoreEvidenceWhere(): Prisma.OrderStatusLogWhereInput {
  return { OR: [{ note: null }, { note: { notIn: [...STORE_EVIDENCE_NOTES] } }] };
}

/** [FOLLOWUPS 11 Nov 2026] The step a status-log row SHOWS on a timeline: a store kitchen tap made
 *  while a rider held the order reads as the kitchen step it was ("Preparing" / "Ready"), never as a
 *  second "Rider assigned" / "Rider on the way" / "Rider at the store". Every other row: its status. */
export function timelineStepOf(row: { status: string; note: string | null }): string {
  if (row.note === STORE_PREPARING_WITH_RIDER_NOTE) return 'PREPARING';
  if (row.note === STORE_READY_WITH_RIDER_NOTE) return 'READY_FOR_PICKUP';
  return row.status;
}

/**
 * The status-log rows that COUNT a mover's assignment episodes (the dispatch journal compares this
 * count before and after an assignment). The store's rows (STORE_EVIDENCE_NOTES: "Handed to rider"
 * and the kitchen steps taken after a rider took the order) can be written while the order sits at
 * RIDER_ASSIGNED; they are not assignments, so they are left out. Every counter of assignment
 * episodes uses this ONE predicate, so they always agree.
 */
export function assignmentLogWhere(orderId: string, status: OrderStatus): Prisma.OrderStatusLogWhereInput {
  return { orderId, status, ...notStoreEvidenceWhere() };
}

/** The status-log rows that decide whether the CURRENT rider was handed the order: the store's taps
 *  and the rider assignments (a rider who hands the order back and the next rider who takes it start
 *  a new episode, so an earlier tap never speaks for the new rider). Read them ordered by createdAt. */
export function handoverEpisodeRowsWhere(orderIds: readonly string[]): Prisma.OrderStatusLogWhereInput {
  return { orderId: { in: [...orderIds] }, OR: [{ note: HANDED_TO_RIDER_NOTE }, { status: 'RIDER_ASSIGNED' }] };
}

/** Per order: the first "Handed to rider" tap since the latest rider assignment (rows oldest first). */
export function handedToRiderSinceAssignment(
  rows: ReadonlyArray<{ orderId: string; status: OrderStatus; note: string | null; createdAt: Date }>,
): Map<string, Date> {
  const handed = new Map<string, Date>();
  for (const row of rows) {
    if (row.note === HANDED_TO_RIDER_NOTE) {
      if (!handed.has(row.orderId)) handed.set(row.orderId, row.createdAt);
    } else if (row.status === 'RIDER_ASSIGNED' && !isStoreEvidenceRow(row)) {
      // A new rider episode: an earlier tap was for an earlier rider. [FOLLOWUPS 11 Nov] A store kitchen
      // tap at RIDER_ASSIGNED is not one (the same rider still holds the order).
      handed.delete(row.orderId);
    }
  }
  return handed;
}
