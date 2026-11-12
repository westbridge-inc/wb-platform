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
 * [FOLLOWUPS 11 Nov 2026 · production rider test: 6 of 13 orders "logged the same rider step 2-3 times"
 * · REVIEW-2490 S3-1] WHICH ROWS ARE STEPS. A step is a row that CHANGED the order's status: the first
 * row, or a row whose status differs from the row before it (oldest first, STEP_ORDER). Every transition
 * writes its row (the canonical seam, the two claim doors, the pre-custody reopen kernel all do), so a
 * status change always opens a new run. Every other row is written AT the order's current status and
 * repeats it: the store's kitchen taps and "Handed to rider", a grocery substitution / refund / withdrawn
 * question (picking.service), a courier's "cash collected from sender" (cash-rules), an MMG attestation,
 * a custody relay. Those are append-only evidence and stay in the log, but none of them is a step: not an
 * assignment episode, not a new handed-to-rider episode, not the start of a rider's clock, and never a
 * second step on a timeline. The rule is positive (a status change), so a new kind of evidence row, with
 * any note, is never read as a step either.
 */
export const STEP_ORDER: Prisma.OrderStatusLogOrderByWithRelationInput[] = [{ createdAt: 'asc' }, { id: 'asc' }];

/** For rows of ONE order, oldest first: whether each row is a step (changed the status). */
export function stepFlags(rows: ReadonlyArray<{ status: string }>): boolean[] {
  return rows.map((row, i) => i === 0 || rows[i - 1]!.status !== row.status);
}

type StepReader = { orderStatusLog: { findMany: (args: { where: { orderId: string }; select: { status: true; createdAt: true }; orderBy: typeof STEP_ORDER }) => Promise<Array<{ status: string; createdAt: Date }>> } };

/** The order's steps (rows that changed its status), oldest first. */
export async function readStatusSteps(db: StepReader, orderId: string): Promise<Array<{ status: string; createdAt: Date }>> {
  const rows = await db.orderStatusLog.findMany({ where: { orderId }, select: { status: true, createdAt: true }, orderBy: STEP_ORDER });
  const steps = stepFlags(rows);
  return rows.filter((_, i) => steps[i]);
}

/**
 * How many times the order was assigned to a mover (`status` RIDER_ASSIGNED or DRIVER_ASSIGNED): its
 * assignment STEPS. The dispatch journal compares this count before and after an assignment; every
 * counter of assignment episodes uses this ONE function, so they always agree. A row written at
 * RIDER_ASSIGNED that is not a step (a store tap, a substitution, a courier's cash) is never an episode;
 * a release always writes its own step (the reopen kernel), so the next assignment is always a new one.
 */
export async function countStatusSteps(db: StepReader, orderId: string, status: OrderStatus): Promise<number> {
  return (await readStatusSteps(db, orderId)).filter((row) => row.status === status).length;
}

/** When the order last stepped into `status` (its latest step there), or null. */
export async function latestStepAt(db: StepReader, orderId: string, status: OrderStatus): Promise<Date | null> {
  const steps = await readStatusSteps(db, orderId);
  for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i]!.status === status) return steps[i]!.createdAt;
  return null;
}

/** The statuses a rider holds the order in before pickup. A row there that is not a step is evidence
 *  written beside the rider (a store tap, a substitution, a courier's cash): never shown as a step. */
const RIDER_PRE_PICKUP: ReadonlySet<string> = new Set(['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP']);

/**
 * [FOLLOWUPS 11 Nov 2026 · REVIEW-2490 S3-2] An order's status history as a TIMELINE (rows oldest first),
 * for the customer's and the store's screens:
 * - a store kitchen tap made while a rider held the order reads as the kitchen step it was ("Preparing" /
 *   "Ready"), never as a second "Rider assigned" / "Rider en route" / "Rider at counter";
 * - "Handed to rider" is left out (both store apps already say "Handed to rider" from handedToRiderAt;
 *   as a row it read as a second "Rider at counter");
 * - every other row at a rider's pre-pickup status that is not a step is left out;
 * - everything else as it is. Every status shown is one every store and customer build has words for.
 */
export function timelineRows<Row extends { status: string; note: string | null }>(rowsOldestFirst: ReadonlyArray<Row>): Array<Row & { status: string }> {
  const steps = stepFlags(rowsOldestFirst);
  const out: Array<Row & { status: string }> = [];
  rowsOldestFirst.forEach((row, i) => {
    if (row.note === HANDED_TO_RIDER_NOTE) return;
    if (row.note === STORE_PREPARING_WITH_RIDER_NOTE) { out.push({ ...row, status: 'PREPARING' }); return; }
    if (row.note === STORE_READY_WITH_RIDER_NOTE) { out.push({ ...row, status: 'READY_FOR_PICKUP' }); return; }
    if (!steps[i] && RIDER_PRE_PICKUP.has(row.status)) return;
    out.push(row);
  });
  return out;
}

/** The status-log rows that decide whether the CURRENT rider was handed the order: every row of the
 *  orders (whether a RIDER_ASSIGNED row is a new episode depends on the row before it). Read them in
 *  STEP_ORDER. */
export function handoverEpisodeRowsWhere(orderIds: readonly string[]): Prisma.OrderStatusLogWhereInput {
  return { orderId: { in: [...orderIds] } };
}

/** Per order: the first "Handed to rider" tap since the latest rider assignment step (every row of the
 *  orders, in STEP_ORDER). */
export function handedToRiderSinceAssignment(
  rows: ReadonlyArray<{ orderId: string; status: OrderStatus; note: string | null; createdAt: Date }>,
): Map<string, Date> {
  const handed = new Map<string, Date>();
  const previous = new Map<string, string>();
  for (const row of rows) {
    const step = previous.get(row.orderId) !== row.status;
    previous.set(row.orderId, row.status);
    if (row.note === HANDED_TO_RIDER_NOTE) {
      if (!handed.has(row.orderId)) handed.set(row.orderId, row.createdAt);
    } else if (row.status === 'RIDER_ASSIGNED' && step) {
      // A new rider episode: an earlier tap was for an earlier rider. [FOLLOWUPS 11 Nov · REVIEW-2490 S3-1]
      // Only an assignment STEP is one: a row written at RIDER_ASSIGNED that repeats it (a kitchen tap, a
      // substitution) is the same rider's episode.
      handed.delete(row.orderId);
    }
  }
  return handed;
}
