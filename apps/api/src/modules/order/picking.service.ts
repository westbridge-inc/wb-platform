import { emitToOrderRoom, emitToStoreRoom } from './order-room-emission.service';
import type { Prisma, PrismaClient, SubstitutionStatus } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService } from '../notification/notification.service';
import { FloatService } from '../dispatch/float.service';
import { AppError, NotFoundError } from '../../utils/errors';
import { applyStockMovement, lockItemsInIdOrder } from '../inventory/stock';
import { assertMmgFulfilmentAllowed } from './order.service';
import { mmgClaimLockObserver } from './mmg-claim.service';
import { substitutionLineChange, substitutionDecideMinutes, substitutionNoAnswer, orderTotalAdjustable, isRemovalQuestion, totalFixedCopy, ONLY_ITEM_LEFT_COPY, PICK_ALIVE_WHERE, type AdjustableOrder } from './substitution-view';
import { storeTeam, ringRecipients } from '../notification/store-team';
import { hiddenAmong, unhideRestocked } from '../compliance/prohibited-gate';
import { recomputeOrderVat, vatOnTopChange } from '../store-vat/order-vat';
import { lineChangeDiscount, type LineDiscountChange } from './line-discount';
import { OptionSelectionError, validateSelectedOptions, type ValidatableGroup } from './options';
import { orderStageRefusal } from './order-status-words';
import { persistRiderCancellationNotice, drainRiderCancellationNotices } from './rider-cancel-notice';
import { ORDER_TRANSITIONS, STORE_REJECTABLE_STATUSES } from './order-status';

/** [REPORT-006 F-006-02] MMG order money is immutable in-app — ANY payment
 *  status. CAPTURED is money the store already received; PENDING is only the
 *  absence of the store's attestation, not proof the customer's external
 *  transfer didn't happen (same doctrine as the conversion block). Until a
 *  durable vendor-refund/adjustment obligation ledger exists (founder-gated),
 *  every picking operation that would rewrite an MMG total fails closed.
 *  Same-price substitutions pass (no money effect); CASH orders pass (the
 *  door handover collects the adjusted amount). */
function assertMmgMoneyAdjustable(order: AdjustableOrder): void {
  // [O-4 · owner 22 Oct 2026] Before the store accepts, no MMG payment can exist
  // yet (the store's number shows only after acceptance; no pay link, no claim):
  // the total may still change, and the customer pays only the total they
  // confirmed. orderTotalAdjustable decides it; an unprojected fact fails closed.
  // [REVIEW-M S4-1 on #2043] The same rule on every rail but cash (card, bank
  // transfer: prepaid, both OFF today). The code stays MMG_ADJUSTMENT_UNAVAILABLE
  // (what clients already handle); the words fit the rail.
  if (orderTotalAdjustable(order)) return;
  throw new AppError(
    409,
    'MMG_ADJUSTMENT_UNAVAILABLE',
    totalFixedCopy(order),
  );
}

// ---------------------------------------------------------------------------
// Grocery picking + substitution (§5.3). Shelf reality beats the database:
// staff tick lines as they pick; an out-of-stock line becomes either a
// substitution the CUSTOMER decides on (live prompt) or a line refund. A
// PENDING substitution blocks Mark-ready — the bag never closes with an open
// question in it. Picking rides INSIDE the existing PREPARING stage: the order
// state machine is locked and gains no new states.
//
// Money honesty: totals here are what's due at handover (cash) or what the
// vendor owes back (MMG already paid) — Swift adjusts numbers, never money.
//
// [REPORT-006 F-006-04/05] Concurrency doctrine: previews (getLine) exist for
// 404s and error copy ONLY. Every mutation either binds live order lifecycle +
// expected line state in its WRITE predicate, or — when money/stock/float move
// — runs one Order-row-locked transaction that revalidates everything from the
// locked row and commits line state, inventory, totals, float, and immutable
// evidence together. Sockets/notifications publish only after commit, and only
// for the CAS winner.
// ---------------------------------------------------------------------------

/** [OOS-FLOW · owner 8 Nov 2026] The reason a store's out-of-stock close records: the store's own
 *  "Out of stock" reject preset (mobile rejectReasons.ts, web reject-reasons.ts), so every app words
 *  it exactly as the store's decline ("The store declined your order: Out of stock."). */
export const OUT_OF_STOCK_REASON = 'Out of stock';

/** [OOS-FLOW] closeLine's refusal to take off the last item still coming on an accepted order. Internal:
 *  every caller turns it into the order's end (cancelForStockOut), never into an empty order. */
const LAST_ITEM_LEFT = 'LAST_ITEM_LEFT' as const;

/** [OOS-FLOW · REVIEW-1 S3-2] The store's removal of the last item still coming, sent without its confirmation
 *  (endsOrder): refused before anything is written. Apps that ask once read this code and ask. */
export const LAST_ITEM_ENDS_ORDER = 'LAST_ITEM_ENDS_ORDER' as const;

/** [OOS-FLOW] closeLine's last-item refusal as a value its caller ends the order on; anything else is rethrown. */
function lastItemLeftOr(error: unknown): typeof LAST_ITEM_LEFT {
  if (error instanceof AppError && error.code === LAST_ITEM_LEFT) return LAST_ITEM_LEFT;
  throw error;
}

/** [OOS-FLOW] What a stock-out close says about money, only where it is certainly true. Cash is paid at
 *  the door or the counter, and every stock-out close happens before pickup: nothing was charged. An
 *  MMG payment still waiting for the store's "Paid by MMG" may already have been sent: the store refunds
 *  it directly (Swift never holds it). Any other rail: nothing is claimed. */
function stockOutMoneyWords(order: { paymentMethod: string | null; paymentStatus?: string | null }): string {
  if (order.paymentMethod === 'CASH') return ' Nothing was charged.';
  if (order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'PENDING') {
    return ' If you already sent the MMG payment, the store refunds you directly.';
  }
  return '';
}

/** Order states where the pick list is editable by the vendor.
 *  [O-4 · owner 22 Oct 2026] PENDING too: BEFORE accepting, the store marks a
 *  line "Out of stock" (a swap or a removal question the customer answers);
 *  ticking a line still waits for the accept (setPicked). */
const PICKABLE_STATES = [
  'PENDING',
  'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
  'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
];

/** [O-4] The order facts orderTotalAdjustable and the MMG gate read, projected
 *  wherever a pick-list write decides on money. */
const ADJUSTABLE_SELECT = {
  status: true, paymentMethod: true, paymentStatus: true, orderType: true, mmgClaimMismatchAt: true,
  acceptedAt: true, mmgAttestedRef: true, customerMmgClaim: true, mmgPayUrlSnapshot: true,
} as const;

/** The line + order facts every vendor pick-list action reads first. */
const LINE_INCLUDE = {
  order: { select: { ...ADJUSTABLE_SELECT, id: true, customerId: true, orderNumber: true, vendorId: true, totalAmount: true } },
} as const;
type PickLine = Prisma.OrderItemGetPayload<{ include: typeof LINE_INCLUDE }>;

/** [O-4] Before acceptance a question is part of the store's answer to the
 *  order (the un-gated ACCEPTED step of the MMG gate); after it, preparation. */
const questionGateTarget = (status: string) => (status === 'PENDING' ? 'ACCEPTED' : 'PREPARING') as 'ACCEPTED' | 'PREPARING';

/** [O-4] A pre-accept question keeps its decision instant on the line
 *  (substituteDecideBy), so the store's response clock restarts from the
 *  customer's answer (autoCancelUnresponsiveOrder, vendorRespondBy). After
 *  acceptance the field is cleared on close, as before. */
const closedQuestionStamp = (status: string, at: Date) => (status === 'PENDING' ? at : null);

type PickableStatus = import('@prisma/client').OrderStatus;

/** [OOS-FLOW] The accepted stages an out-of-stock close may end: the pick list is open and the goods
 *  are still in the store (a rider may be assigned or on the way, never holding them). */
const STOCK_OUT_CANCELLABLE = PICKABLE_STATES.filter(
  // The state machine decides which of them may be cancelled at all (order-status.ts ORDER_TRANSITIONS).
  (st) => st !== 'PENDING' && (ORDER_TRANSITIONS.CANCELLED as readonly string[]).includes(st),
) as PickableStatus[];

/** [OOS-FLOW] The line and order facts an out-of-stock close reads. */
type StockOutLine = {
  id: string;
  orderId: string;
  name: string;
  order: { customerId: string; orderNumber: string; vendorId: string | null };
};

export class PickingService {
  private notifications: NotificationService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
    /** [O-4] The canonical seam, built by the caller WITH its Redis (offer withdrawal, census B4):
     *  needed only to cancel a waiting order whose only item got no answer. Without it that
     *  question stays open and the no-response clock ends the order (never removed into nothing). */
    private orderService?: Pick<import('./order.service').OrderService, 'transitionOrderAtomically'>,
  ) {
    this.notifications = new NotificationService(prisma, io);
  }

  /**
   * A line is SETTLED when nobody is still waiting on a decision about it:
   * it is picked, or its substitution question was closed by a refund or a
   * customer rejection.
   *
   * [W-28] Settled is not the same as FULFILLED, and conflating the two was
   * the defect. A refunded or rejected line has been removed from the order —
   * the money came off, the stock went back — so an order whose every line is
   * refused is settled on every line and contains nothing. It was still
   * markable ready, and went out for delivery: a rider dispatched to carry an
   * empty bag, a customer charged a delivery fee for it.
   */
  static lineResolved(line: { picked: boolean; subStatus: string }): boolean {
    // [O-4 · owner 22 Oct 2026] The store accepts the WHOLE order: a tick is a
    // tool, never a gate. A line is unsettled only while the customer is still
    // deciding on it (an open swap or removal question).
    return line.subStatus !== 'PENDING';
  }

  /** [W-28] A line is FULFILLED when something is actually going in the bag:
   *  [O-4] every line the store did not take off (ticked or not). */
  static lineFulfilled(line: { picked: boolean; subStatus: string }): boolean {
    return line.subStatus !== 'PENDING' && line.subStatus !== 'REFUNDED' && line.subStatus !== 'REJECTED';
  }

  /** Gate for Mark-ready on quantity-tracked stores: no open lines. */
  async unresolvedLines(orderId: string): Promise<number> {
    return (await this.readiness(orderId)).unresolved;
  }

  /**
   * [W-28] The readiness of an order as the SERVER sees it, in one read: how
   * many lines still need a decision, how many are actually being handed over,
   * and how many were removed. `ready` is the invariant the mark-ready route
   * enforces — every line settled AND at least one line fulfilled.
   */
  async readiness(orderId: string): Promise<{ total: number; unresolved: number; fulfilled: number; removed: number; ready: boolean }> {
    const lines = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { picked: true, subStatus: true },
    });
    const unresolved = lines.filter((l) => !PickingService.lineResolved(l)).length;
    const fulfilled = lines.filter((l) => PickingService.lineFulfilled(l)).length;
    return {
      total: lines.length,
      unresolved,
      fulfilled,
      removed: lines.length - unresolved - fulfilled,
      ready: unresolved === 0 && fulfilled > 0,
    };
  }

  private async getLine(orderId: string, lineId: string): Promise<PickLine> {
    const line = await this.prisma.orderItem.findFirst({
      where: { id: lineId, orderId },
      include: LINE_INCLUDE,
    });
    if (!line) throw new NotFoundError('Order line', lineId);
    if (!PICKABLE_STATES.includes(line.order.status)) {
      throw new AppError(409, 'NOT_PICKABLE', orderStageRefusal(line.order.status, 'the pick list is closed'));
    }
    return line;
  }

  /** Staff tick/untick a shelf-picked line. */
  async setPicked(orderId: string, lineId: string, picked: boolean) {
    const line = await this.getLine(orderId, lineId);
    // [O-4] Ticks belong to preparation: before the accept, a line is only ever
    // marked "Out of stock".
    if (line.order.status === 'PENDING') {
      throw new AppError(409, 'ACCEPT_FIRST', 'Accept the order first. Before accepting you can only mark an item out of stock.');
    }
    // [SPS-F-0016 / REPORT-004 F-004-05] Ticking a line IS preparing the order
    // — gated for unpaid MMG like every other affirmative prep action.
    // Unticking (corrective) stays open. This preview check only answers
    // early; the authority is the same gate on the LOCKED row below.
    if (picked) assertMmgFulfilmentAllowed(line.order, 'PREPARING');
    if (line.subStatus === 'PENDING') {
      throw new AppError(409, 'SUBSTITUTION_OPEN', 'Resolve the substitution before picking this line');
    }
    if (line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED') {
      throw new AppError(409, 'LINE_CLOSED', 'This line was refunded — nothing to pick');
    }
    // [REPORT-006 F-006-05] The write re-binds live order lifecycle and line
    // state — a cancellation or line closure committing after the preview
    // matches nothing instead of mutating a closed order.
    // [ORDER-SPINE S1-6] And it commits under the order-row lock the direct-MMG
    // claim authority takes, with the MMG gate re-run on the locked row: a
    // customer's "I did not pay" committing after the preview is seen here.
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockPickableOrder(tx, orderId);
      if (picked) assertMmgFulfilmentAllowed(order, 'PREPARING');
      return tx.orderItem.updateMany({
        where: {
          id: lineId,
          orderId,
          subStatus: { notIn: ['PENDING', 'REFUNDED', 'REJECTED'] },
          order: { status: { in: PICKABLE_STATES.filter((st) => st !== 'PENDING') as PickableStatus[] } },
        },
        data: { picked },
      });
    });
    if (updated.count === 0) {
      throw new AppError(409, 'NOT_PICKABLE', 'This line just changed — refresh the order');
    }
    this.emitPickState(line.order.vendorId, orderId, lineId, { picked });
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /**
   * [ORDER-SPINE S1-6] The fence an affirmative pick-list write commits under:
   * the SAME order-row lock the direct-MMG claim authority, cancellation and
   * the canonical transitions take, then the live row read through it. A
   * customer's denial either commits first — and the gate on this row refuses
   * — or waits for this write, which then preceded the dispute.
   */
  private async lockPickableOrder(tx: Prisma.TransactionClient, orderId: string) {
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: ADJUSTABLE_SELECT,
    });
    if (!order) throw new NotFoundError('Order', orderId);
    await mmgClaimLockObserver.afterLock?.({ orderId, actor: 'PICK' });
    if (!PICKABLE_STATES.includes(order.status)) {
      throw new AppError(409, 'NOT_PICKABLE', orderStageRefusal(order.status, 'the pick list is closed'));
    }
    return order;
  }

  /**
   * Out of stock → propose a substitute. Only items from the SAME vendor and
   * (when the original declares one) the same substitutionGroup qualify — the
   * customer decides, live.
   */
  async proposeSubstitution(orderId: string, lineId: string, substituteItemId: string, changedBy: string) {
    const line = await this.getLine(orderId, lineId);
    // [SPS-F-0016] Proposing a substitute is affirmative preparation — gated.
    // (Early answer only; the authority is the gate on the locked row below.)
    // [O-4] Before the accept it is part of the store's answer (ACCEPTED gate).
    assertMmgFulfilmentAllowed(line.order, questionGateTarget(line.order.status));
    if (line.picked) throw new AppError(409, 'ALREADY_PICKED', 'This line is already picked');
    if (line.subStatus !== 'NONE') {
      throw new AppError(409, 'SUBSTITUTION_EXISTS', `This line is already ${line.subStatus.toLowerCase()}`);
    }

    const [original, substitute] = await Promise.all([
      line.itemId ? this.prisma.item.findUnique({ where: { id: line.itemId } }) : null,
      this.prisma.item.findUnique({ where: { id: substituteItemId }, include: { optionGroups: { include: { options: true } } } }),
    ]);
    if (!substitute || substitute.vendorId !== line.order.vendorId) {
      throw new NotFoundError('Substitute item', substituteItemId);
    }
    if (!substitute.isAvailable) {
      throw new AppError(409, 'SUBSTITUTE_UNAVAILABLE', 'That substitute is itself unavailable');
    }
    if (itemNeedsChoices(substitute)) throw substituteNeedsChoices();
    // [GUARDRAILS §8] A substitution never puts a prohibited item on an order.
    if ((await hiddenAmong(this.prisma, [substitute.id])).size > 0) {
      throw new AppError(409, 'SUBSTITUTE_UNAVAILABLE', 'That substitute isn\'t available on Swift');
    }
    if (original?.substitutionGroup && substitute.substitutionGroup !== original.substitutionGroup) {
      throw new AppError(400, 'WRONG_GROUP', 'Substitutes must come from the same substitution group');
    }
    // [SUBSTITUTION · owner 17 Oct] A question nobody can ever answer is never
    // asked. An MMG total can't change in-app, so on MMG a swap at a different
    // price could be neither approved nor declined (both rewrite the total) and
    // the order would wait forever. Only a same-price swap may be proposed
    // there; the store settles anything else with the customer directly.
    // (Early answer; the authority is the same check on the locked row below.)
    const swapLine = substitutionLineChange({
      substitutePrice: substitute.basePrice, quantity: line.quantity, totalCustomer: line.totalCustomer,
    });
    // [STORE-VAT-EXCLUSIVE] On an order whose VAT is added on top, a same-price swap to an item of another VAT class still
    // moves the total (its VAT line), so it counts as a change here too: never a question nobody can answer.
    const priceChange = swapLine.delta + await this.vatOnTopChangeOf(orderId, line.vatClass, { lineId, newLineTotal: swapLine.newLineTotal, vatClass: substitute.vatClass });
    if (priceChange !== 0) assertMmgMoneyAdjustable(line.order);
    // [SUBSTITUTION] The wait is bounded: past decideBy the sweep removes the
    // line (never a silent swap) or, on MMG, withdraws the question.
    const decideMinutes = substitutionDecideMinutes();
    const decideBy = new Date(Date.now() + decideMinutes * 60_000);

    // [REPORT-006 F-006-05 · ORDER-SPINE S1-6] Proposing a substitute is
    // affirmative preparation: the MMG gate runs on the LOCKED order row, and
    // the proposal commits with its status-log evidence under that lock, bound
    // to live lifecycle and line state. A cancellation or a customer's "I did
    // not pay" committing after the preview leaves nothing to propose on.
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockPickableOrder(tx, orderId);
      assertMmgFulfilmentAllowed(order, questionGateTarget(order.status));
      if (priceChange !== 0) assertMmgMoneyAdjustable(order);
      const updated = await tx.orderItem.updateMany({
        where: {
          id: lineId,
          orderId,
          subStatus: 'NONE',
          picked: false,
          order: { status: { in: PICKABLE_STATES as PickableStatus[] } },
        },
        data: {
          subStatus: 'PENDING',
          substituteItemId,
          substituteName: substitute.name,
          substitutePrice: substitute.basePrice,
          substituteDecideBy: decideBy,
          // [STORE-VAT-EXCLUSIVE · REVIEW-B S3-4] On an order that froze VAT, the substitute's class is frozen with its
          // price: the card and the yes both use THIS class, never one the store sets after the question was asked.
          substituteVatClass: line.vatClass != null ? substitute.vatClass : null,
        },
      });
      if (updated.count === 0) {
        throw new AppError(409, 'SUBSTITUTION_EXISTS', 'This line just changed — refresh the order');
      }
      await tx.orderStatusLog.create({
        data: { orderId, status: order.status as PickableStatus, changedBy, note: `Substitution proposed: ${line.name} → ${substitute.name}` },
      });
    });
    // [OOS-FLOW] Read after the commit, for the push's words only: is this the only item still coming?
    const onlyItem = await this.lastItemLeft(orderId, lineId);
    // Only the committed winner speaks.
    await emitToOrderRoom(this.prisma, this.io, orderId, 'order:substitution', {
      orderId,
      lineId,
      originalName: line.name,
      substituteName: substitute.name,
      substitutePrice: Number(substitute.basePrice),
      quantity: line.quantity,
      status: 'PENDING',
      decideBy: decideBy.toISOString(),
    });
    // [SUBSTITUTION] The push says how long the question waits and what
    // happens without an answer, in words true on every build.
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `${line.name} is out of stock`,
      body: substitutionNoAnswer(line.order) === 'REMOVE' && onlyItem
        // [OOS-FLOW · owner 8 Nov 2026] The only item left: no answer (or, once accepted, a "no thanks")
        // cancels the order instead of emptying it, so the push never says it "comes off".
        ? `The store suggests ${substitute.name} instead of ${line.name}, the only item left on order #${line.order.orderNumber}. Approve it in the app within ${decideMinutes} minutes, or the order is cancelled. Nothing has been charged.`
        : substitutionNoAnswer(line.order) === 'REMOVE'
        ? `The store suggests ${substitute.name} instead for order #${line.order.orderNumber}. Approve or decline it in the app within ${decideMinutes} minutes. If you don't answer, it comes off your order and your total goes down.`
        : `The store suggests ${substitute.name} instead for order #${line.order.orderNumber}. If it isn't approved in the app within ${decideMinutes} minutes, the store settles this item with you directly.`,
      data: { orderId, kind: 'substitution_pending', lineId },
    });
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /** No substitute possible → refund the line: totals shrink, stock returns.
   *  [O-4] Before the store accepts, the line is not removed yet: the CUSTOMER
   *  is asked (askRemoval) — continue without it, or cancel the order. */
  async refundLine(orderId: string, lineId: string, changedBy: string, opts: { endsOrder?: boolean } = {}) {
    const line = await this.getLine(orderId, lineId);
    if (line.order.status === 'PENDING') return this.askRemoval(line, changedBy);
    if (line.picked) throw new AppError(409, 'ALREADY_PICKED', 'This line is already picked');
    // Idempotent on BOTH closed states [REPORT-005 F-005-02]: a customer
    // rejection also closes the line — refunding it again double-decremented
    // totals and double-restocked.
    if (line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED') return line;
    // [OOS-FLOW · owner 8 Nov 2026] The last item still coming: taking it off left an accepted order
    // with nothing in it, stuck in preparation (Ready refused, nothing to cancel). The order ends
    // instead, as the store's decline "Out of stock". (Preview; closeLine decides again on the lock.)
    // [OOS-FLOW · REVIEW-1 S3-2 · COORD ruling] Only when the store CONFIRMED it (endsOrder, sent by an app
    // that asked once first): an older app's one tap, or a second device that did not know it was the last
    // item, gets the question back in words instead of a silent cancel.
    if (await this.lastItemLeft(orderId, lineId)) return this.storeStockOutCloseIfConfirmed(line, changedBy, opts.endsOrder === true);
    // [F-006-02] Fail-fast preview for honest copy; the authoritative check
    // re-runs inside closeLine's locked transaction.
    assertMmgMoneyAdjustable(line.order);

    const closed = await this.closeLine(line, 'REFUNDED', changedBy).catch(lastItemLeftOr);
    if (closed === LAST_ITEM_LEFT) return this.storeStockOutCloseIfConfirmed(line, changedBy, opts.endsOrder === true);
    // [REPORT-006 F-006-05] Only the CAS winner speaks: a lost duplicate race
    // must not send the customer a second "removed from your order" push.
    if (closed) {
      await this.notifications.send({
        userId: line.order.customerId,
        type: 'ORDER_UPDATE',
        title: `${line.name} removed from your order`,
        // [STORE-VAT-EXCLUSIVE] On an order whose VAT is added on top, the VAT that went with the line comes off too.
        // [REVIEW-A F7] What the total actually went down by: the line less the discount share that went with it (closeLine's
        // decTotal, as the no-answer sweep says), plus that VAT.
        body: `It's out of stock at the store. Order #${line.order.orderNumber}'s total went down by $${(closed.decTotal + closed.vatDrop).toLocaleString()}.`,
        data: { orderId, kind: 'line_refunded', lineId },
      });
      return this.prisma.orderItem.findUnique({ where: { id: lineId } });
    }
    // Lost the CAS: honest only if the winner reached the SAME outcome. A
    // duplicate refund/reject landing first is an idempotent success; losing
    // to a concurrent APPROVAL means the line is now the substitute — saying
    // "refunded" would be a lie, so surface the conflict.
    const finalLine = await this.prisma.orderItem.findUnique({ where: { id: lineId } });
    if (finalLine && (finalLine.subStatus === 'REFUNDED' || finalLine.subStatus === 'REJECTED')) {
      return finalLine;
    }
    throw new AppError(409, 'LINE_CHANGED', 'This line just changed — refresh the order');
  }

  /**
   * [O-4 · owner 22 Oct 2026] "Out of stock" with nothing to swap, BEFORE the
   * store accepts. Consumer protection: the customer agrees to the changed
   * order before paying. So the line becomes an open question with nothing
   * proposed (subStatus PENDING, no substitute): "Continue without it" removes
   * it (the server lowers the total), "Cancel order" is the free cancel a
   * waiting order already has. No answer by decideBy = removed (the safe
   * default the swap question already uses: the total only goes down). The
   * store accepts the rest after the answer (the accept refuses while a
   * question is open). Same lock, gates and evidence as a swap proposal.
   */
  private async askRemoval(line: PickLine, changedBy: string) {
    const orderId = line.order.id;
    if (line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED') return line;
    if (line.subStatus !== 'NONE') {
      throw new AppError(409, 'CUSTOMER_DECIDING', `The customer is still deciding about ${line.name}. Wait for the answer, or reject the order.`);
    }
    assertMmgFulfilmentAllowed(line.order, 'ACCEPTED');
    assertMmgMoneyAdjustable(line.order);
    const decideMinutes = substitutionDecideMinutes();
    const decideBy = new Date(Date.now() + decideMinutes * 60_000);
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockPickableOrder(tx, orderId);
      if (order.status !== 'PENDING') {
        throw new AppError(409, 'LINE_CHANGED', 'This order just changed — refresh it');
      }
      assertMmgFulfilmentAllowed(order, 'ACCEPTED');
      assertMmgMoneyAdjustable(order);
      // [O-4 · COORD 03:34Z, the shared last-item rule] The only item left (every other line off or
      // on its way off): there is nothing to continue with, so the store rejects the order instead.
      const alive = await tx.orderItem.count({ where: { orderId, id: { not: line.id }, ...PICK_ALIVE_WHERE } });
      if (alive === 0) {
        throw new AppError(409, 'REJECT_INSTEAD', `${line.name} is the only item left on this order. Reject the order instead, with the reason "Out of stock".`);
      }
      const asked = await tx.orderItem.updateMany({
        where: { id: line.id, orderId, subStatus: 'NONE', picked: false, order: { status: 'PENDING' } },
        data: { subStatus: 'PENDING', substituteItemId: null, substituteName: null, substitutePrice: null, substituteVatClass: null, substituteDecideBy: decideBy },
      });
      if (asked.count === 0) {
        throw new AppError(409, 'LINE_CHANGED', 'This line just changed — refresh the order');
      }
      await tx.orderStatusLog.create({
        data: { orderId, status: 'PENDING', changedBy, note: `Out of stock, customer asked: ${line.name}` },
      });
    });
    this.emitPickState(line.order.vendorId, orderId, line.id, { subStatus: 'PENDING' });
    await emitToOrderRoom(this.prisma, this.io, orderId, 'order:substitution', {
      orderId, lineId: line.id, originalName: line.name, substituteName: null, substitutePrice: null,
      quantity: line.quantity, status: 'PENDING', kind: 'REMOVAL', decideBy: decideBy.toISOString(),
    });
    // [STORE-VAT-EXCLUSIVE] On an order whose VAT is added on top, the line's VAT comes off with it (the same rule the
    // removal itself applies, vatOnTopChange).
    const lower = Math.min(Number(line.totalCustomer) - (await this.vatOnTopChangeOf(orderId, line.vatClass, { lineId: line.id, newLineTotal: 0 })), Number(line.order.totalAmount));
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `${line.name} is out of stock`,
      body: `The store can't supply ${line.name} for order #${line.order.orderNumber}. In the app, continue without it (your total goes down by $${lower.toLocaleString()}) or cancel the order, within ${decideMinutes} minutes. If you don't answer, it comes off your order and your total goes down.`,
      data: { orderId, kind: 'substitution_pending', lineId: line.id },
    });
    return this.prisma.orderItem.findUnique({ where: { id: line.id } });
  }

  /** [STORE-VAT-EXCLUSIVE] The change a picking change makes to an order's added VAT, read before it happens (0 unless the
   *  order's VAT is added on top). `lineVatClass` is the line's frozen class: null on every order that froze no VAT, which
   *  needs no read at all. */
  private async vatOnTopChangeOf(orderId: string, lineVatClass: string | null | undefined, change: { lineId: string; newLineTotal: number; vatClass?: string | null }): Promise<number> {
    if (lineVatClass == null) return 0;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        vatRateBps: true, vatOnTop: true, vatAmount: true, discount: true,
        items: { select: { id: true, subStatus: true, totalCustomer: true, vatClass: true }, orderBy: { id: 'asc' } },
        promoRedemption: { select: { funder: true, goodsDiscount: true, lineAllocations: true, discountType: true, discountValue: true, maxDiscount: true } },
      },
    });
    return order ? vatOnTopChange(order, change) : 0;
  }

  /** The customer's verdict on a pending substitution. */
  async decideSubstitution(orderId: string, lineId: string, customerId: string, approve: boolean, opts: { endsOrder?: boolean } = {}) {
    const line = await this.prisma.orderItem.findFirst({
      where: { id: lineId, orderId, order: { customerId } },
      include: { order: { select: {
        ...ADJUSTABLE_SELECT,
        id: true, customerId: true, orderNumber: true, vendorId: true,
      } } },
    });
    if (!line) throw new NotFoundError('Order line', lineId);
    if (line.subStatus !== 'PENDING') {
      throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
    }

    // [O-4] A removal question (nothing proposed): "Continue without it" is the
    // yes — the line comes off and the total goes down. Its other answer is
    // "Cancel order" (the free cancel of a waiting order), never a decline here.
    if (isRemovalQuestion(line)) {
      if (!approve) {
        throw new AppError(409, 'CANCEL_INSTEAD', 'To keep this item you can cancel the order instead: nothing has been charged.');
      }
      assertMmgMoneyAdjustable(line.order);
      const closed = await this.closeLine(line, 'REFUNDED', customerId, { note: `Customer continued without: ${line.name}`, requireOthersLeft: true });
      if (closed) {
        await this.tellStoreTheCustomerAnswered(line.order, `${line.name}: the customer continues without it`);
        return this.prisma.orderItem.findUnique({ where: { id: lineId } });
      }
      const finalLine = await this.prisma.orderItem.findUnique({ where: { id: lineId } });
      if (finalLine && (finalLine.subStatus === 'REFUNDED' || finalLine.subStatus === 'REJECTED')) return finalLine;
      throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
    }

    if (!approve) {
      // A rejection ALSO rewrites totals (closeLine decrements the line) — on
      // MMG that is an unrecorded refund [F-006-02]. Preview fail-fast; the
      // locked transaction inside closeLine re-asserts from the live row.
      assertMmgMoneyAdjustable(line.order);
      const closed = await this.closeLine(line, 'REJECTED', customerId, { requireOthersLeft: true }).catch(lastItemLeftOr);
      // [OOS-FLOW · owner 8 Nov 2026] "No thanks" to a swap for the only item left on an accepted order:
      // there is nothing to go ahead with, so the order is cancelled (never counted against the customer).
      if (closed === LAST_ITEM_LEFT) {
        // [OOS-FLOW · REVIEW-1 S3-1 · COORD ruling] Only a client that showed "No thanks, cancel order" may end
        // the order this way (it says so with endsOrder); any other answer gets the question back in words.
        if (opts.endsOrder !== true) {
          throw new AppError(409, LAST_ITEM_ENDS_ORDER,
            `${line.name} is the only item left on your order, so saying no thanks cancels the order. Approve the swap, or cancel the order (update the app to do it in one step). Nothing has been charged.`);
        }
        await this.declinedOrUnansweredStockOutClose(line, {
          changedBy: customerId,
          closeAs: 'REJECTED',
          lineWhere: { subStatus: 'PENDING', picked: false },
          reason: `Out of stock: ${line.name} was the only item and the suggested swap was declined`,
          customerBody: `You said no thanks to the swap for ${line.name}, the only item left on order #${line.order.orderNumber}, so the order was cancelled.`,
          storeBody: `The customer said no thanks to the swap for ${line.name}, the only item left, so the order was cancelled. Nothing more to do.`,
        });
        return this.prisma.orderItem.findUnique({ where: { id: lineId } });
      }
      if (closed) {
        await this.tellStoreTheCustomerAnswered(line.order, `${line.name}: the customer declined the swap, so it comes off`);
        return this.prisma.orderItem.findUnique({ where: { id: lineId } });
      }
      // Lost the CAS. A concurrent duplicate reject (or a vendor refund) is
      // the same outcome — idempotent success. Losing to a concurrent
      // APPROVAL is a conflicting decision: the line is now the substitute,
      // and a 200 here would tell the customer their rejection stuck.
      const finalLine = await this.prisma.orderItem.findUnique({ where: { id: lineId } });
      if (finalLine && (finalLine.subStatus === 'REFUNDED' || finalLine.subStatus === 'REJECTED')) {
        return finalLine;
      }
      throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
    }

    // Approve: the line BECOMES the substitute — name/price swap, totals move
    // by the price difference × qty. Stock: substitute decrements (guarded,
    // oversell-impossible), the original goes back on the shelf.
    //
    // [REPORT-006 F-006-04/05] One Order-locked transaction owns the whole
    // decision: live lifecycle + payment validation, an expected-state line
    // CAS (two concurrent approvals have exactly one winner), both inventory
    // moves, the totals delta, the assigned rider's committed CASH float, and
    // the immutable status log. Everything commits or nothing does — the old
    // shape moved stock before an unconditional line write, so a double
    // approval doubled stock moves and totals.
    const approved = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.order.findFirst({
        where: { id: orderId, customerId },
        select: {
          ...ADJUSTABLE_SELECT,
          id: true, riderId: true, totalAmount: true, vendorId: true, discount: true,
        },
      });
      if (!order) throw new NotFoundError('Order', orderId);
      if (!PICKABLE_STATES.includes(order.status)) {
        throw new AppError(409, 'NOT_PICKABLE', orderStageRefusal(order.status, 'the pick list is closed'));
      }
      assertMmgFulfilmentAllowed(order, questionGateTarget(order.status));

      const fresh = await tx.orderItem.findFirst({ where: { id: lineId, orderId } });
      if (!fresh || fresh.subStatus !== 'PENDING') {
        throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
      }
      // [GUARDRAILS §8 · DS1106 S2] The substitute is judged again at the customer's yes, under the
      // order lock: a person may have removed it, or its words changed, since the store proposed it.
      if (fresh.substituteItemId && (await hiddenAmong(tx, [fresh.substituteItemId])).size > 0) {
        throw new AppError(409, 'SUBSTITUTE_UNAVAILABLE', 'That substitute isn\'t available on Swift');
      }
      // [Audit M-1] Judged again at the yes: the store may have given the item sizes or a required choice since.
      if (fresh.substituteItemId) {
        const sub = await tx.item.findUnique({ where: { id: fresh.substituteItemId }, select: { optionGroups: { include: { options: true } } } });
        if (sub && itemNeedsChoices(sub)) throw substituteNeedsChoices();
      }

      const substitutePrice = Number(fresh.substitutePrice ?? 0);
      // [L09 · M028] The one formula, also what the customer was shown before
      // deciding (substitution-view.ts): the substitute's price × quantity
      // replaces the line's total, paid options included.
      const { newLineTotal, delta } = substitutionLineChange(fresh);

      // [F-006-02] On MMG, a dearer substitute records money never collected
      // and a cheaper one an unrecorded refund — any payment status. Only a
      // same-price swap may proceed until the adjustment/refund ledger exists.
      if (delta !== 0) assertMmgMoneyAdjustable(order);
      // [Review A S3-1 on #2500] The discount follows the goods (line-discount.ts): a cheaper substitute on a
      // discounted order gives back the part of the discount that went with the difference, so the other lines are
      // never discounted twice. The total moves by the line's change less that part: what the customer was shown.
      const discountBack = await lineChangeDiscountInTx(tx, orderId, { lineId, newLineTotal }, order.discount);
      const totalChange = delta + discountBack.amount;

      // A substitute may reduce a line's price but must NEVER drive the ORDER
      // total below zero. On a discounted order a free/cheap substitute could
      // otherwise invert the total into "the platform owes the customer".
      if (Number(order.totalAmount) + totalChange < 0) {
        throw new AppError(400, 'SUBSTITUTE_NEGATIVE_TOTAL', 'That substitute would drop the order total below zero — refund the line instead.');
      }

      // Exactly-one approval: expected-state CAS on the line.
      const cas = await tx.orderItem.updateMany({
        where: { id: lineId, subStatus: 'PENDING', picked: false },
        data: {
          subStatus: 'APPROVED',
          substituteDecideBy: closedQuestionStamp(order.status, new Date()),
          picked: false, // staff still has to shelf-pick the substitute
          name: `${fresh.substituteName} (sub for ${fresh.name})`,
          basePrice: substitutePrice,
          markedUpPrice: substitutePrice,
          totalBase: newLineTotal,
          totalCustomer: newLineTotal,
        },
      });
      if (cas.count === 0) {
        throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
      }
      // [STORE-VAT] On an order that froze VAT, the line now carries the SUBSTITUTE's VAT class. [REVIEW-B S3-4] The class
      // frozen when the store proposed it (the one the customer's card showed); only a proposal made before that column
      // reads the item now, as before. A substitute with no item row keeps the line's class.
      if (fresh.vatClass != null && fresh.substituteItemId) {
        const subClass = fresh.substituteVatClass != null
          ? { vatClass: fresh.substituteVatClass }
          : await tx.item.findUnique({ where: { id: fresh.substituteItemId }, select: { vatClass: true } });
        if (subClass) await tx.orderItem.update({ where: { id: lineId }, data: { vatClass: subClass.vatClass } });
      }

      // Two items move here (the substitute off the shelf, the original back):
      // lock them in id order first, as every multi-item stock path does.
      await lockItemsInIdOrder(tx, [fresh.substituteItemId, fresh.itemId]);
      if (fresh.substituteItemId) {
        const sub = await tx.item.findUnique({
          where: { id: fresh.substituteItemId },
          select: { stockQuantity: true },
        });
        if (sub?.stockQuantity != null) {
          // [MKT-2] Through the single writer — same conditional guard, now with
          // a ledger row. A substitution moves real goods off a real shelf, so
          // it is a movement like any other.
          try {
            await applyStockMovement(tx, {
              itemId: fresh.substituteItemId,
              delta: -fresh.quantity,
              reason: 'PICK',
              orderId: fresh.orderId,
              note: 'Substitute picked',
            });
          } catch {
            throw new AppError(409, 'SUBSTITUTE_OUT_OF_STOCK', 'The substitute just sold out — ask the store to pick another');
          }
          // Mirror the inventory engine: hitting zero auto-hides from browse.
          await tx.item.updateMany({
            where: { id: fresh.substituteItemId, stockQuantity: { lte: 0 }, isAvailable: true },
            data: { isAvailable: false, autoHiddenAt: new Date() },
          });
        }
      }
      await this.restockLine(fresh, 'customer approved substitution', tx);

      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotalBase: { increment: delta },
          subtotalCustomer: { increment: delta },
          totalAmount: { increment: totalChange },
          ...(discountBack.amount > 0 ? { discount: { decrement: discountBack.amount } } : {}),
        },
      });
      if (discountBack.redemption) await tx.promoRedemption.update({ where: { orderId }, data: discountBack.redemption });
      // [STORE-VAT] The VAT inside the goods follows the goods (a no-op on an order without VAT).
      // [STORE-VAT-EXCLUSIVE] On an order whose VAT is added on top, its "VAT 14%" line and the total move with it
      // (taxDelta, written by recompute): a swap to a standard-rated item at the same price still changes the total.
      const taxDelta = (await recomputeOrderVat(tx, orderId))?.taxDelta ?? 0;
      if (taxDelta !== 0) assertMmgMoneyAdjustable(order);
      // What the rider fronts the store moves by the goods AND their added VAT (riderFloatForOrder).
      const cashDelta = delta + taxDelta;

      // [REPORT-006 F-006-05] Committed float tracks the LIVE cash subtotal a
      // rider fronts: a cheaper substitute releases the difference now, or the
      // terminal release under-unwinds and the rider's float headroom leaks.
      // [O1 · reviewer B S2 · riders choose] A DEARER one on a CASH order a rider already holds is refused: the rider
      // agreed to pay the store the amount they were shown, and a swap must never add cash to their job without their
      // say (before a rider holds it, the claim checks the shown amount instead: cash-limit assertCashShown). The
      // whole approval rolls back; the customer is told why here, the store by the notice after the transaction.
      if (order.paymentMethod === 'CASH' && order.riderId && cashDelta > 0) {
        // [OOS-FLOW · REVIEW-1 S4-1] Declining the only item left cancels the order: the words say so.
        const others = await tx.orderItem.count({ where: { orderId, id: { not: lineId }, ...PICK_ALIVE_WHERE } });
        throw new AppError(409, 'SUBSTITUTE_RAISES_RIDER_CASH', others === 0
          ? 'A rider has already taken this order and agreed to pay the store the amount they were shown, so a dearer swap cannot be added. It is the only item left: say no thanks to cancel the order (nothing has been charged), or ask the store for a same-price option.'
          : 'A rider has already taken this order and agreed to pay the store the amount they were shown, so a dearer swap cannot be added. Decline this swap (the item comes off your order), or ask the store for a same-price option.');
      }
      if (order.paymentMethod === 'CASH' && order.riderId && cashDelta < 0) {
        await new FloatService(tx).release(tx, order.riderId, -cashDelta);
      }

      await tx.orderStatusLog.create({
        data: { orderId, status: order.status as PickableStatus, changedBy: customerId, note: `Substitution approved: ${fresh.substituteName}` },
      });
      return { vendorId: order.vendorId };
    }).catch(async (error: unknown) => {
      // [O1 · reviewer B S2] The store is told why the swap it offered did not go through (the customer has the
      // refusal itself); nothing changed, the question stays open for a refund or a same-price option.
      if (error instanceof AppError && error.code === 'SUBSTITUTE_RAISES_RIDER_CASH') {
        await this.tellStoreSwapRefusedForRider(line.order, line.name, await this.lastItemLeft(orderId, lineId).catch(() => false));
      }
      throw error;
    });

    this.emitPickState(approved.vendorId, orderId, lineId, { subStatus: 'APPROVED' });
    await this.tellStoreTheCustomerAnswered(line.order, `${line.name}: the customer approved the swap`);
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /** Shared close-out for refund/reject: totals shrink, stock returns.
   *  Returns true only for the CAS winner — callers publish nothing on false. */
  private async closeLine(
    line: { id: string; itemId: string | null; substituteItemId: string | null; name: string; quantity: number; totalCustomer: unknown; subStatus: SubstitutionStatus; order: { id: string; status: string; vendorId: string | null } },
    subStatus: 'REFUNDED' | 'REJECTED',
    changedBy: string,
    opts: { note?: string; decidedBefore?: Date; requireOthersLeft?: boolean } = {},
  ): Promise<false | { decTotal: number; vatDrop: number }> {
    // [REPORT-006 F-006-02/05] One Order-locked transaction: live lifecycle +
    // payment-rail authority come from the LOCKED row (never the caller's
    // preview — a capture or cancellation committing after the preview is
    // seen here), the line CAS picks exactly one winner, and money, float,
    // stock + its audit row, and the status log commit together. The old
    // shape released float and restocked AFTER commit — a crash there could
    // never heal because the idempotent early-return skips closed lines.
    const closed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${line.order.id} FOR UPDATE`;
      const ord = await tx.order.findUniqueOrThrow({
        where: { id: line.order.id },
        select: {
          ...ADJUSTABLE_SELECT,
          riderId: true,
          subtotalBase: true, subtotalCustomer: true, totalAmount: true, discount: true,
        },
      });
      if (!PICKABLE_STATES.includes(ord.status)) {
        throw new AppError(409, 'NOT_PICKABLE', orderStageRefusal(ord.status, 'the pick list is closed'));
      }
      assertMmgMoneyAdjustable(ord);
      // [O-4 · REVIEW-F S3-1] On a waiting order a customer's answer never empties it: the only
      // item left is not removed by "continue" or a declined swap (the customer cancels instead).
      // Decided on the LOCKED rows: two answers racing on the last two lines cannot both remove.
      // [OOS-FLOW · owner 8 Nov 2026] After acceptance NO removal empties the order (the store's
      // "Remove item", a declined swap, no answer): the last item still coming is refused here, before
      // anything is written, and the caller ends the order instead (cancelForStockOut). Two removals
      // racing on the last two lines: the second waits for this lock and sees none left.
      if (ord.status !== 'PENDING' || opts.requireOthersLeft) {
        const others = await tx.orderItem.count({ where: { orderId: line.order.id, id: { not: line.id }, ...PICK_ALIVE_WHERE } });
        if (others === 0) {
          if (ord.status === 'PENDING') throw new AppError(409, 'ONLY_ITEM_LEFT', ONLY_ITEM_LEFT_COPY);
          throw new AppError(409, LAST_ITEM_LEFT, `${line.name} is the only item left on this order.`);
        }
      }

      // Floor the order totals at 0. On a discounted order the stored discount
      // can equal (or exceed) a line's share, so decrementing by the FULL line
      // total would drive subtotal/total negative — "the platform owes the
      // customer", nonsensical for a cash handover. The substitution sibling
      // throws (it has an alternative); a refund must always succeed, so we
      // CLAMP the decrement per field instead of blocking it.
      const lineTotal = Number(line.totalCustomer);
      const decBase = Math.min(lineTotal, Number(ord.subtotalBase));
      const decCustomer = Math.min(lineTotal, Number(ord.subtotalCustomer));
      // [Audit FABLE-01 A-1] The line leaves with the discount it carried: the customer stops paying its price
      // less its own share, and the order's discount (and the promo's goods discount) shrink by that share. Taking
      // the full price off left the other lines discounted twice (a 50% code on two equal lines made the second free).
      const share = await lineChangeDiscountInTx(tx, line.order.id, { lineId: line.id, newLineTotal: 0 }, ord.discount);
      const decTotal = Math.min(Math.max(0, lineTotal - share.amount), Number(ord.totalAmount));

      // [REPORT-005 F-005-02] Exactly-one close: the line update is a CAS on
      // the caller's observed subStatus. A lost race exits before any money,
      // float, stock, or socket effect.
      const cas = await tx.orderItem.updateMany({
        where: {
          id: line.id, subStatus: line.subStatus, picked: false,
          // [SUBSTITUTION] The deadline sweep removes only a question whose
          // wait is over on the row it writes, not on the row it read.
          ...(opts.decidedBefore ? { substituteDecideBy: { lte: opts.decidedBefore } } : {}),
        },
        data: { subStatus, substituteItemId: null, substituteName: null, substitutePrice: null, substituteVatClass: null, substituteDecideBy: closedQuestionStamp(ord.status, new Date()) },
      });
      if (cas.count === 0) return false;
      await tx.order.update({
        where: { id: line.order.id },
        data: {
          subtotalBase: { decrement: decBase },
          subtotalCustomer: { decrement: decCustomer },
          totalAmount: { decrement: decTotal },
          ...(share.amount > 0 ? { discount: { decrement: share.amount } } : {}),
        },
      });
      if (share.redemption) {
        await tx.promoRedemption.update({ where: { orderId: line.order.id }, data: share.redemption });
      }
      // [STORE-VAT] A removed line carries no VAT any more (a no-op on an order without VAT).
      // [STORE-VAT-EXCLUSIVE] On an order whose VAT is added on top, its "VAT 14%" line and the total drop with it.
      const vatDrop = -((await recomputeOrderVat(tx, line.order.id))?.taxDelta ?? 0);
      await tx.orderStatusLog.create({
        data: { orderId: line.order.id, status: ord.status as PickableStatus, changedBy, note: opts.note ?? `Line ${subStatus.toLowerCase()}: ${line.name}` },
      });
      // Keep a CASH rider's committed float in sync with the subtotal it
      // fronts: this close shrinks subtotalBase by decBase, and the terminal
      // release later unwinds only the REDUCED subtotal — without releasing
      // the delta now, committedFloat stays perma-leaked.
      // [STORE-VAT-EXCLUSIVE] The rider fronts the goods AND their added VAT: both come back.
      if (ord.paymentMethod === 'CASH' && ord.riderId && decBase + vatDrop > 0) {
        await new FloatService(tx).release(tx, ord.riderId, decBase + vatDrop);
      }
      // [REPORT-007-v4 F-04] The goods reserved by an APPROVED substitution
      // are the SUBSTITUTE units (the original went back on the shelf at
      // approval) — refunding that line must return the substitute, or the
      // original is restocked twice while the substitute strands decremented
      // (possibly auto-hidden at zero) with the wrong RETURN audit row.
      const restockItemId = line.subStatus === 'APPROVED' ? line.substituteItemId : line.itemId;
      await this.restockLine({ itemId: restockItemId, quantity: line.quantity, orderId: line.order.id }, subStatus.toLowerCase(), tx);
      return { decTotal, vatDrop };
    });
    if (!closed) return false;
    this.emitPickState(line.order.vendorId, line.order.id, line.id, { subStatus });
    await emitToOrderRoom(this.prisma, this.io, line.order.id, 'order:substitution', { orderId: line.order.id, lineId: line.id, status: subStatus });
    return closed;
  }

  /**
   * [SUBSTITUTION · owner 17 Oct 2026] A swap question past its deadline.
   * The SAFE default, never a silent swap: the line is REMOVED — it comes off
   * the order, the total drops (clamped like any removal), stock returns, the
   * customer is told, and the store can carry on. On MMG, where the total can't
   * change in-app, the question is WITHDRAWN instead: the line is back to the
   * store as it was, and the customer is told the store settles it directly.
   * A question opened before deadlines existed gets a full wait from now.
   * Every write is a compare-and-set on the open question, so a customer's
   * answer or a store's removal landing first wins and this does nothing.
   */
  async expireSubstitution(lineId: string, now: Date = new Date()): Promise<'removed' | 'withdrawn' | 'started' | 'cancelled' | 'skipped'> {
    const line = await this.prisma.orderItem.findFirst({
      where: { id: lineId, subStatus: 'PENDING', picked: false },
      include: { order: { select: { ...ADJUSTABLE_SELECT, id: true, customerId: true, orderNumber: true, vendorId: true } } },
    });
    if (!line || !PICKABLE_STATES.includes(line.order.status)) return 'skipped';
    const removal = isRemovalQuestion(line);
    if (!line.substituteDecideBy) {
      const started = await this.prisma.orderItem.updateMany({
        where: { id: line.id, subStatus: 'PENDING', picked: false, substituteDecideBy: null },
        data: { substituteDecideBy: new Date(now.getTime() + substitutionDecideMinutes() * 60_000) },
      });
      return started.count > 0 ? 'started' : 'skipped';
    }
    if (line.substituteDecideBy.getTime() > now.getTime()) return 'skipped';
    const changedBy = 'system:substitution-expiry';

    if (substitutionNoAnswer(line.order) === 'WITHDRAW') {
      const withdrawn = await this.prisma.$transaction(async (tx) => {
        const order = await this.lockPickableOrder(tx, line.orderId);
        const cas = await tx.orderItem.updateMany({
          where: { id: line.id, subStatus: 'PENDING', picked: false, substituteDecideBy: { lte: now } },
          data: { subStatus: 'NONE', substituteItemId: null, substituteName: null, substitutePrice: null, substituteVatClass: null, substituteDecideBy: null },
        });
        if (cas.count === 0) return false;
        await tx.orderStatusLog.create({
          data: { orderId: line.orderId, status: order.status as PickableStatus, changedBy, note: removal ? `Out-of-stock question withdrawn, no answer in time: ${line.name}` : `Substitution withdrawn, no answer in time: ${line.name} → ${line.substituteName ?? 'substitute'}` },
        });
        return true;
      });
      if (!withdrawn) return 'skipped';
      this.emitPickState(line.order.vendorId, line.orderId, line.id, { subStatus: 'NONE' });
      await emitToOrderRoom(this.prisma, this.io, line.orderId, 'order:substitution', { orderId: line.orderId, lineId: line.id, status: 'NONE' });
      await this.notifications.send({
        userId: line.order.customerId,
        type: 'ORDER_UPDATE',
        title: removal ? `${line.name}: the question closed` : `${line.name}: the swap question closed`,
        body: removal
          ? `The store's question about ${line.name} on order #${line.order.orderNumber} got no answer in time. The store settles ${line.name} with you directly.`
          : `The store's swap question on order #${line.order.orderNumber} got no answer in time. The store settles ${line.name} with you directly.`,
        data: { orderId: line.orderId, lineId: line.id },
      });
      return 'withdrawn';
    }

    // [O-4 · REVIEW-F S3-1] The only item left on a waiting order: removing it would empty the
    // order, so no answer cancels it, free (a system cancellation: never the customer's fault).
    if (line.order.status === 'PENDING') {
      const others = await this.prisma.orderItem.count({ where: { orderId: line.orderId, id: { not: line.id }, ...PICK_ALIVE_WHERE } });
      if (others === 0) return this.cancelOnlyItemLeft(line, now);
    }
    const closed = await this.closeLine(line, 'REFUNDED', changedBy, {
      decidedBefore: now,
      note: removal ? `Line removed, no answer to the out-of-stock question in time: ${line.name}` : `Line removed, no answer to the swap in time: ${line.name}`,
    }).catch(lastItemLeftOr);
    // [OOS-FLOW · owner 8 Nov 2026] No answer about the only item left on an accepted order: the order
    // can't go ahead, so it is cancelled (a system close, never the customer's fault), as on a waiting one.
    if (closed === LAST_ITEM_LEFT) {
      const ended = await this.declinedOrUnansweredStockOutClose(line, {
        changedBy: null,
        closeAs: 'REFUNDED',
        lineWhere: { subStatus: 'PENDING', picked: false, substituteDecideBy: { lte: now } },
        reason: `Out of stock: ${line.name} was the only item and the customer did not answer in time`,
        customerBody: `${line.name} is out of stock and was the only item left on order #${line.order.orderNumber}. The store's swap question got no answer in time, so the order was cancelled.`,
        storeBody: `${line.name}: the swap question got no answer in time and it was the only item left, so the order was cancelled. Nothing more to do.`,
      });
      return ended ? 'cancelled' : 'skipped';
    }
    if (!closed) return 'skipped';
    if (line.order.status === 'PENDING') await this.tellStoreTheCustomerAnswered(line.order, `${line.name}: no answer in time, so it came off`);
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `${line.name} removed from your order`,
      body: removal
        ? `You didn't answer in time, so ${line.name} (out of stock) came off order #${line.order.orderNumber}. Your total went down by $${(closed.decTotal + closed.vatDrop).toLocaleString()}.`
        : `The store's swap question got no answer in time, so ${line.name} came off order #${line.order.orderNumber}. Your total went down by $${(closed.decTotal + closed.vatDrop).toLocaleString()}.`,
      data: { orderId: line.orderId, kind: 'line_refunded', lineId: line.id },
    });
    return 'removed';
  }

  /**
   * [O-4 · REVIEW-F S3-1] No answer about the only item left on a waiting order: the order can't
   * go ahead. One canonical locked PENDING -> CANCELLED, re-decided on the locked rows (the line is
   * still the open question past its deadline and nothing else is left), cancelledBy unset (never
   * counted against the customer). Nothing has been charged: before acceptance no payment exists
   * (an MMG order past that point was WITHDRAWN above, never cancelled here).
   */
  private async cancelOnlyItemLeft(
    line: { id: string; orderId: string; name: string; order: { customerId: string; orderNumber: string; vendorId: string | null } },
    now: Date,
  ): Promise<'cancelled' | 'skipped'> {
    if (!this.orderService) return 'skipped';
    const reason = `Out of stock: ${line.name} was the only item and the customer did not answer in time`;
    try {
      await this.orderService.transitionOrderAtomically({
        orderId: line.orderId,
        target: 'CANCELLED',
        allowedFrom: ['PENDING'],
        changedBy: null,
        note: reason,
        cancellation: { by: null, reason },
        releaseStaleMoverPointer: true,
        withinTransaction: async (tx) => {
          const still = await tx.orderItem.count({ where: { id: line.id, subStatus: 'PENDING', picked: false, substituteDecideBy: { lte: now } } });
          const others = await tx.orderItem.count({ where: { orderId: line.orderId, id: { not: line.id }, ...PICK_ALIVE_WHERE } });
          if (still === 0 || others > 0) throw new AppError(409, 'NOT_ONLY_ITEM_LEFT', 'The order changed; the question is handled the usual way');
        },
        invalidStatus: () => new AppError(409, 'NOT_ONLY_ITEM_LEFT', 'The order is no longer waiting'),
      });
    } catch (error) {
      if (error instanceof AppError && (error.code === 'NOT_ONLY_ITEM_LEFT' || error.code === 'NOT_FOUND')) return 'skipped';
      throw error;
    }
    await emitToOrderRoom(this.prisma, this.io, line.orderId, 'order:status_changed', { orderId: line.orderId, status: 'CANCELLED' });
    if (line.order.vendorId) await emitToStoreRoom(this.prisma, this.io, line.order.vendorId, 'order:status_changed', { orderId: line.orderId, status: 'CANCELLED' });
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `Order #${line.order.orderNumber} cancelled`,
      body: `${line.name} is out of stock and was the only item on your order, so the order was cancelled. Nothing has been charged.`,
      data: { orderId: line.orderId, status: 'CANCELLED' },
    });
    return 'cancelled';
  }

  /** [OOS-FLOW] Is this the last item still coming on the order (every other line came off, or is on its
   *  way off)? A preview: the locked transaction decides again (closeLine, cancelForStockOut). */
  private async lastItemLeft(orderId: string, lineId: string): Promise<boolean> {
    const others = await this.prisma.orderItem.count({ where: { orderId, id: { not: lineId }, ...PICK_ALIVE_WHERE } });
    return others === 0;
  }

  /**
   * [OOS-FLOW · owner 8 Nov 2026] The store took off the last item still coming on an accepted order
   * ("Out of stock" → remove). The order used to stay in preparation with nothing in it: the customer saw
   * the item marked out of stock and nothing else happened, and Ready was refused. Now it ends exactly
   * as the store's decline with the reason "Out of stock" (cancelledBy the store's user, the reject
   * route's push and live events), through the one canonical seam: stock back, rider and float
   * released, the live offer withdrawn. Paid MMG is refused there, as a reject is.
   */
  /** [OOS-FLOW · REVIEW-1 S3-2 · COORD ruling] The last item still coming ends the order only when the store
   *  confirmed exactly that (endsOrder). Otherwise nothing is written and the store reads what removing it does
   *  (a new app shows its ask on LAST_ITEM_ENDS_ORDER; an older app shows these words). */
  private async storeStockOutCloseIfConfirmed(line: PickLine, changedBy: string, endsOrder: boolean) {
    if (!endsOrder) {
      const rejectable = (STORE_REJECTABLE_STATUSES as readonly string[]).includes(line.order.status);
      throw new AppError(409, LAST_ITEM_ENDS_ORDER,
        `${line.name} is the only item left on this order, so removing it cancels the order. Update the app to confirm it there, ${rejectable ? 'or reject the order with the reason "Out of stock"' : 'or contact Swift support to close it'}.`);
    }
    return this.storeStockOutClose(line, changedBy);
  }

  private async storeStockOutClose(line: PickLine, changedBy: string) {
    const ended = await this.cancelForStockOut(line, {
      by: changedBy,
      reason: OUT_OF_STOCK_REASON,
      note: `Out of stock: ${line.name} was the only item left, so the store declined the order`,
      closeAs: 'REFUNDED',
      lineWhere: { subStatus: line.subStatus, picked: false },
    });
    if (!ended) {
      // A concurrent change (another line came back, or this one closed): nothing was written.
      throw new AppError(409, 'LINE_CHANGED', 'This order just changed — refresh it');
    }
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Order declined',
      body: `Your order ${line.order.orderNumber} was declined by the store. ${OUT_OF_STOCK_REASON}: ${line.name} was the only item left.${stockOutMoneyWords(ended)}`,
      data: { orderId: line.orderId, status: 'CANCELLED' },
    });
    return this.prisma.orderItem.findUnique({ where: { id: line.id } });
  }

  /** [OOS-FLOW] The customer's "No thanks", or no answer, about the only item left on an accepted order:
   *  a system close (cancelledBy unset: never counted against the customer). Both sides are told. */
  private async declinedOrUnansweredStockOutClose(
    line: StockOutLine,
    input: { changedBy: string | null; closeAs: 'REFUNDED' | 'REJECTED'; lineWhere: Prisma.OrderItemWhereInput; reason: string; customerBody: string; storeBody: string },
  ): Promise<boolean> {
    // [REVIEW-1 S4-2] The status log names who decided (the customer's "No thanks"); cancelledBy stays unset
    // (a system close, never counted against the customer).
    const ended = await this.cancelForStockOut(line, { by: null, changedBy: input.changedBy, reason: input.reason, note: input.reason, closeAs: input.closeAs, lineWhere: input.lineWhere });
    if (!ended) return false;
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `Order #${line.order.orderNumber} cancelled`,
      body: `${input.customerBody}${stockOutMoneyWords(ended)}`,
      data: { orderId: line.orderId, status: 'CANCELLED' },
    });
    await this.tellStoreOrderEnded(line.order, line.orderId, input.storeBody);
    return true;
  }

  /**
   * [OOS-FLOW · owner 8 Nov 2026] THE out-of-stock end of an accepted order whose last item cannot be
   * supplied. One canonical locked transition (OrderService.transitionOrderAtomically, the seam every
   * cancellation uses; never a new path): accepted stages only, re-decided on the locked rows (the line
   * is still in the state the caller decided on, and no other line is still coming), the line closed
   * in the same commit. The seam puts the stock back (this line included, once), releases an assigned
   * rider and their cash float, closes the dispatch search, withdraws a live offer and refuses paid MMG.
   * The order's totals stay as they were: a cancelled order is owed nothing. An assigned rider is told
   * through the durable rider notice. Returns the payment facts of the closed order, or null when the
   * order changed first (nothing written). Without the seam (a caller that did not pass it) nothing is
   * ever emptied: the store is told to reject instead.
   */
  private async cancelForStockOut(
    line: StockOutLine,
    input: { by: string | null; changedBy?: string | null; reason: string; note: string; closeAs: 'REFUNDED' | 'REJECTED'; lineWhere: Prisma.OrderItemWhereInput },
  ): Promise<{ paymentMethod: string; paymentStatus: string } | null> {
    if (!this.orderService) {
      throw new AppError(409, 'REJECT_INSTEAD', `${line.name} is the only item left on this order. Reject the order instead, with the reason "Out of stock".`);
    }
    let facts: { paymentMethod: string; paymentStatus: string; riderId: string | null } | null = null;
    try {
      await this.orderService.transitionOrderAtomically({
        orderId: line.orderId,
        target: 'CANCELLED',
        allowedFrom: STOCK_OUT_CANCELLABLE,
        changedBy: input.changedBy === undefined ? input.by : input.changedBy,
        note: input.note,
        cancellation: { by: input.by, reason: input.reason },
        releaseStaleMoverPointer: true,
        withinTransaction: async (tx, source) => {
          const still = await tx.orderItem.count({ where: { ...input.lineWhere, id: line.id, orderId: line.orderId } });
          const others = await tx.orderItem.count({ where: { orderId: line.orderId, id: { not: line.id }, ...PICK_ALIVE_WHERE } });
          if (still === 0 || others > 0) throw new AppError(409, 'NOT_ONLY_ITEM_LEFT', 'The order changed; the item is handled the usual way');
          // The seam already put this line's goods back (restockCancelledOrder runs before this hook and
          // skips only lines closed earlier), so closing it here returns nothing a second time.
          await tx.orderItem.update({
            where: { id: line.id },
            data: { subStatus: input.closeAs, substituteItemId: null, substituteName: null, substitutePrice: null, substituteVatClass: null, substituteDecideBy: null },
          });
          if (source.riderId) {
            await persistRiderCancellationNotice(tx, source,
              source.status === 'RIDER_ARRIVED_PICKUP'
              // [REVIEW-1 S4-3] Already at the counter: nothing to collect, free to go.
              ? `Order #${source.orderNumber} was cancelled: the store is out of stock. There is nothing to collect; check your current jobs.`
              : `Order #${source.orderNumber} was cancelled: the store is out of stock. Stop travelling to its pickup and check your current jobs.`);
          }
          facts = { paymentMethod: source.paymentMethod, paymentStatus: source.paymentStatus, riderId: source.riderId };
        },
        invalidStatus: (current) => new AppError(409, 'NOT_PICKABLE', orderStageRefusal(current, 'the pick list is closed')),
        // [BUG-HUNT-2 G08] The reject route's own words: the store is told who closes it, and what it then owes.
        paidMmgRefusal: () => new AppError(409, 'MMG_CANCEL_UNAVAILABLE', 'This order is already paid by MMG, so it cannot be rejected in the app. Contact Swift support: they close it and record the refund you owe the customer. Swift never holds the money.'),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_ONLY_ITEM_LEFT') return null;
      throw error;
    }
    const closed = facts as { paymentMethod: string; paymentStatus: string; riderId: string | null } | null;
    if (!closed) return null;
    if (closed.riderId) {
      await drainRiderCancellationNotices({ prisma: this.prisma, notifications: this.notifications }, { orderId: line.orderId })
        .catch(() => undefined); // the durable notice stays pending; the sweep retries it
    }
    const event = { orderId: line.orderId, status: 'CANCELLED', reason: input.reason, timestamp: new Date().toISOString() };
    await emitToOrderRoom(this.prisma, this.io, line.orderId, 'order:status_changed', event);
    if (line.order.vendorId) await emitToStoreRoom(this.prisma, this.io, line.order.vendorId, 'order:status_changed', event);
    await emitToOrderRoom(this.prisma, this.io, line.orderId, 'order:substitution', { orderId: line.orderId, lineId: line.id, status: input.closeAs });
    return { paymentMethod: closed.paymentMethod, paymentStatus: closed.paymentStatus };
  }

  /** [OOS-FLOW] The store team hears that an order it was preparing ended on the customer's side of a
   *  stock-out (a declined swap, or no answer). A notice, never the decision. */
  private async tellStoreOrderEnded(order: { vendorId: string | null; orderNumber: string }, orderId: string, body: string): Promise<void> {
    if (!order.vendorId) return;
    try {
      const team = await storeTeam(this.prisma, order.vendorId);
      if (!team) return;
      for (const userId of ringRecipients(team)) {
        await this.notifications.send({
          userId,
          type: 'ORDER_UPDATE',
          title: `Order #${order.orderNumber} cancelled`,
          body,
          data: { kind: 'vendor_customer_answered', orderId, orderNumber: order.orderNumber, audience: 'business' },
        });
      }
    } catch {
      // A notice, never the decision: the close already committed.
    }
  }

  /** [O1 · reviewer B S2] A dearer swap the customer said yes to was refused because a rider already holds the cash
   *  order: the store hears why, so it offers a same-price option or the item comes off. A notice, never the decision. */
  private async tellStoreSwapRefusedForRider(order: { id?: string; vendorId: string | null; orderNumber: string }, itemName: string, onlyItem = false): Promise<void> {
    if (!order.vendorId || !order.id) return;
    try {
      const team = await storeTeam(this.prisma, order.vendorId);
      if (!team) return;
      for (const userId of ringRecipients(team)) {
        await this.notifications.send({
          userId,
          type: 'ORDER_UPDATE',
          title: `Order #${order.orderNumber}: the swap could not be added`,
          body: onlyItem
            // [OOS-FLOW · REVIEW-1 S4-1] Removing the only item left cancels the order.
            ? `${itemName}: the customer said yes to the dearer swap, but a rider has already taken this cash order and agreed to pay you the amount they were shown. Offer a same-price option. It is the only item left, so removing it cancels the order.`
            : `${itemName}: the customer said yes to the dearer swap, but a rider has already taken this cash order and agreed to pay you the amount they were shown. Offer a same-price option or refund the item.`,
          data: { kind: 'vendor_customer_answered', orderId: order.id, orderNumber: order.orderNumber, audience: 'business' },
        });
      }
    } catch {
      // A notice, never the decision: the refusal already stands.
    }
  }

  /** [O-4 · REVIEW-G S4-2 on #2043] Asking the customer before accepting answered the store's
   *  new-order alert. When the customer answers (or the question times out), the store team is
   *  told at once that the order can be accepted now. One push, no SMS ladder. */
  private async tellStoreTheCustomerAnswered(
    order: { id?: string; status: string; vendorId: string | null; orderNumber: string },
    what: string,
  ): Promise<void> {
    if (order.status !== 'PENDING' || !order.vendorId || !order.id) return;
    try {
      const team = await storeTeam(this.prisma, order.vendorId);
      if (!team || !team.ringing) return;
      // [REVIEW-F S4-1 on #2043] "Accept now" only when nothing is left to answer: never a tap the
      // server would refuse (CUSTOMER_DECIDING).
      const stillOpen = await this.prisma.orderItem.count({ where: { orderId: order.id, subStatus: 'PENDING' } });
      const next = stillOpen > 0
        ? (stillOpen === 1 ? 'One more item is still waiting on the customer.' : `${stillOpen} more items are still waiting on the customer.`)
        : 'You can accept the order now.';
      for (const userId of ringRecipients(team)) {
        await this.notifications.send({
          userId,
          type: 'ORDER_UPDATE',
          title: `Order #${order.orderNumber}: the customer answered`,
          body: `${what}. ${next}`,
          data: { kind: 'vendor_customer_answered', orderId: order.id, orderNumber: order.orderNumber, audience: 'business' },
        });
      }
    } catch {
      // A notice, never the decision: the answer already committed.
    }
  }

  /** Put a line's units back on the shelf (tracked items only) + log it. */
  private async restockLine(
    line: { itemId: string | null; quantity: number; orderId: string },
    note: string,
    db: Prisma.TransactionClient | PrismaClient = this.prisma,
  ) {
    if (!line.itemId) return;
    // [MKT-2] Through the single writer. It no-ops on an untracked item, which
    // is the same rule the `stockQuantity: { not: null }` guard enforced here.
    // The movement names its order, like the sale it gives back, so the units
    // an open order still holds net to zero for this line (POS-SYNC
    // unitsHeldByOpenOrders).
    // [POS-SYNC · Sol S2] Only units this order actually took are given back
    // in its name. An order placed before the item tracked stock took nothing
    // from the count; naming it on a return would cancel another open order's
    // hold. Whatever it did not take is still put back, as before, but not in
    // its name. The item lock serializes this read with every stock writer.
    await lockItemsInIdOrder(db, [line.itemId]);
    const taken = await db.stockMovement.aggregate({
      where: { itemId: line.itemId, orderId: line.orderId },
      _sum: { delta: true },
    });
    const ownUnits = Math.min(line.quantity, Math.max(0, -(taken._sum.delta ?? 0)));
    const parts = [
      { delta: ownUnits, orderId: line.orderId },
      { delta: line.quantity - ownUnits, orderId: null },
    ].filter((part) => part.delta > 0);
    let applied = false;
    for (const part of parts) {
      const restock = await applyStockMovement(db, {
        itemId: line.itemId,
        delta: part.delta,
        reason: 'PICK_REFUND',
        orderId: part.orderId,
        note: `picking: ${note}`,
      });
      applied = applied || restock.applied;
    }
    if (applied) {
      await unhideRestocked(db, line.itemId); // never a banned item [GUARDRAILS §8 · DS1266 S3]
      await db.stockAdjustment.create({
        data: { itemId: line.itemId, delta: line.quantity, reason: 'RETURN', note: `picking: ${note}` },
      });
    }
  }

  private emitPickState(vendorId: string | null, orderId: string, lineId: string, patch: object) {
    // Fire-and-forget like before; the store-room gate never throws.
    if (vendorId) void emitToStoreRoom(this.prisma, this.io, vendorId, 'order:pick_state', { orderId, lineId, ...patch });
  }
}

/**
 * [SUBSTITUTION · owner 17 Oct 2026] The once-a-minute deadline sweep: every
 * open swap question on a live order whose wait is over (or that has no
 * deadline yet) goes through expireSubstitution, one line at a time, each in
 * its own order's tenant (`narrow`; the job passes inTenantOf). A failure on
 * one line never stops the rest; it is counted and retried next minute.
 */
export async function sweepSubstitutionDeadlines(
  prisma: PrismaClient,
  io: Server,
  opts: {
    now?: Date;
    limit?: number;
    narrow?: <T>(orderId: string, fn: () => Promise<T>) => Promise<T>;
    /** [O-4] See PickingService: lets a waiting order whose only item got no answer be cancelled, free. */
    orderService?: Pick<import('./order.service').OrderService, 'transitionOrderAtomically'>;
  } = {},
): Promise<{ removed: number; withdrawn: number; started: number; cancelled: number; failed: number }> {
  const now = opts.now ?? new Date();
  const narrow = opts.narrow ?? (<T>(_orderId: string, fn: () => Promise<T>) => fn());
  const due = await prisma.orderItem.findMany({
    where: {
      subStatus: 'PENDING',
      picked: false,
      OR: [{ substituteDecideBy: { lte: now } }, { substituteDecideBy: null }],
      order: { status: { in: PICKABLE_STATES as PickableStatus[] } },
    },
    select: { id: true, orderId: true },
    orderBy: { substituteDecideBy: 'asc' },
    take: opts.limit ?? 200,
  });
  const result = { removed: 0, withdrawn: 0, started: 0, cancelled: 0, failed: 0 };
  const picking = new PickingService(prisma, io, opts.orderService);
  for (const line of due) {
    try {
      const outcome = await narrow(line.orderId, () => picking.expireSubstitution(line.id, now));
      if (outcome !== 'skipped') result[outcome] += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/**
 * [Audit FABLE-01 A-1 · Review A S3-1] The discount that goes with a line changed at picking (removed, or swapped for
 * a substitute at another price), by the one rule in line-discount.ts, and what that does to the promo redemption.
 * Read inside the order-locked transaction, BEFORE the line's own row changes.
 */
async function lineChangeDiscountInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  change: LineDiscountChange,
  orderDiscount: unknown,
): Promise<{ amount: number; redemption: Prisma.PromoRedemptionUpdateInput | null }> {
  if (!(Number(orderDiscount) > 0)) return { amount: 0, redemption: null };
  const live = await tx.orderItem.findMany({ where: { orderId, subStatus: { notIn: ['REFUNDED', 'REJECTED'] } }, select: { id: true, totalCustomer: true }, orderBy: { id: 'asc' } });
  const redemption = await tx.promoRedemption.findUnique({
    where: { orderId },
    select: { goodsDiscount: true, lineAllocations: true, discountType: true, discountValue: true, maxDiscount: true },
  });
  const result = lineChangeDiscount({ orderDiscount, live: live.map((l) => ({ id: l.id, amount: Number(l.totalCustomer) })), change, redemption });
  return {
    amount: result.amount,
    redemption: result.redemption
      ? { goodsDiscount: result.redemption.goodsDiscount, ...(result.redemption.lineAllocations ? { lineAllocations: result.redemption.lineAllocations as Prisma.InputJsonValue } : {}) }
      : null,
  };
}

/** [Audit FABLE-01 M-1] A swap carries no selection, so an item that needs one is never a substitute. */
function substituteNeedsChoices(): AppError {
  return new AppError(409, 'SUBSTITUTE_NEEDS_CHOICES', 'That item needs a choice (a size or another required option), and a swap cannot carry one. Offer a plain item, or settle it with the customer.');
}

/**
 * [Audit FABLE-01 M-1] True when the item cannot be ordered with no choices: a size sets its price (its basePrice is
 * only the "from" price) or a group needs an answer. A swap carries no selection, so such an item is never a
 * substitute: it would be charged its "from" price, and the kitchen would not know what to make. Decided by the one
 * validator, on an empty selection.
 */
function itemNeedsChoices(item: { optionGroups?: ValidatableGroup[] | null }): boolean {
  try {
    validateSelectedOptions(item, {});
    return false;
  } catch (error) {
    if (error instanceof OptionSelectionError) return true;
    throw error;
  }
}
