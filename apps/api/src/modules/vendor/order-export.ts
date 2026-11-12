import { Readable } from 'node:stream';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { csvTextCell } from '../../utils/csv';
import { guyanaDayKey, isDateOnly, startOfGuyanaDay, endOfGuyanaDay } from '../../utils/guyana-day';
import { vendorVisibleFilter } from '../order/hold-visibility';
import {
  customerCancellation, orderPeople, supportCancellationSentence, SYSTEM_CANCELLATION_CODES,
} from '../order/customer-cancellation';
import { orderComponents } from '../billing/sales-components';
import { tenantContext } from '../../plugins/tenant-context';

// ---------------------------------------------------------------------------
// [ORDER-EXPORT · owner 11 Nov 2026] A store's order history as a CSV file, for
// finance reconciliation: one branch, or every branch the caller may see sales
// for (a chain owner: all of them; a manager: the stores they manage). Staff
// never (they do not see revenue).
//
// Data minimisation (GUARDRAILS §2): finance columns only. No customer name,
// phone, address, location, note or the customer's own payment reference; a
// cancellation reason is the one the customer may read (customer-cancellation.ts),
// never the customer's own words or Swift support's internal note.
//
// Every text cell goes through csvTextCell (formula-safe: = + - @ tab CR get a
// leading apostrophe). Rows are read in pages of ORDER_EXPORT_BATCH and written
// as they come, so a year of a busy chain never sits in memory at once.
//
// [REVIEW-2485-B · M-38] The money is split exactly as the sales statement splits
// it (billing/sales-components.ts orderComponents, from the promo redemption
// record): the store's own promotion, what Swift owes the store for a Swift-funded
// goods discount, the Swift-funded delivery discount, and `store_goods_net` (goods
// less the store's own promotion), so summing `store_goods_net` over a range gives
// the sales statement's total for the same days. The delivery fee and tip are the
// rider's on a Swift-rider order and the store's on its own delivery: two columns,
// so a sum of the store's columns never includes the rider's money. The store-money
// columns are filled only for a finished sale (delivered or completed).
// ---------------------------------------------------------------------------

export const ORDER_EXPORT_AUDIT_ACTION = 'VENDOR_ORDERS_EXPORTED';
/** The longest range one file may cover, in Guyana days (a leap year). */
export const ORDER_EXPORT_MAX_DAYS = 366;
export const ORDER_EXPORT_BATCH = 500;
/** [REVIEW-2485-A S3-1] One export at a time per person (a Redis key, freed when the file ends or the client leaves). */
export const ORDER_EXPORT_LOCK_PREFIX = 'order-export:running:';
/** The longest one export may hold the slot if its stream never closes (a crash): then it frees itself. */
export const ORDER_EXPORT_LOCK_TTL_S = 15 * 60;

/** [REVIEW-2485-DELTA S4-1] Delete the lock only if it still holds THIS export's token (an export that outlived the
 *  TTL must never free the slot a later export took). */
const RELEASE_IF_MINE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
export async function releaseOrderExportLock(
  redis: { eval: (script: string, keys: number, ...args: string[]) => Promise<unknown> },
  key: string,
  token: string,
): Promise<void> {
  await redis.eval(RELEASE_IF_MINE, 1, key, token);
}

export const ORDER_EXPORT_COLUMNS = [
  'order_number', 'branch', 'branch_city', 'order_status', 'fulfilment', 'express',
  'placed_at_guyana', 'placed_at_iso', 'accepted_at_guyana', 'accepted_at_iso', 'ready_at_guyana', 'ready_at_iso',
  'completed_at_guyana', 'completed_at_iso', 'cancelled_at_guyana', 'cancelled_at_iso',
  'payment_method', 'payment_status', 'payment_note', 'mmg_paid_claim', 'mmg_store_reference', 'item_count', 'currency',
  'food_subtotal', 'discount', 'discount_store_funded', 'discount_swift_funded_goods', 'discount_swift_funded_delivery', 'discount_estimated', 'promo_code',
  'delivery_fee', 'service_fee', 'tip', 'tax', 'vat_included', 'total',
  'store_goods_net', 'store_delivery_fee_and_tip', 'rider_delivery_fee_and_tip',
  'cancelled_by', 'cancellation_reason', 'refund_owed', 'refund_paid', 'refund_note',
] as const;

export interface OrderExportPeriod { fromDay: string; toDay: string; from: Date; to: Date; days: number }

/** The requested Guyana days, checked: real dates, start not after end, not past today, at most 366 days. */
export function orderExportPeriod(query: { from?: unknown; to?: unknown }, now = new Date()): OrderExportPeriod {
  const { from, to } = query;
  const realDay = (v: unknown): v is string => isDateOnly(v) && guyanaDayKey(startOfGuyanaDay(v)) === v.trim();
  if (!realDay(from) || !realDay(to)) {
    throw new AppError(400, 'EXPORT_RANGE_INVALID', 'Choose a start day and an end day.');
  }
  const fromDay = from.trim();
  const toDay = to.trim();
  if (fromDay > toDay) throw new AppError(400, 'EXPORT_RANGE_INVALID', 'The end day is before the start day.');
  if (fromDay > guyanaDayKey(now)) throw new AppError(400, 'EXPORT_RANGE_INVALID', 'The start day is in the future.');
  const days = Math.round((startOfGuyanaDay(toDay).getTime() - startOfGuyanaDay(fromDay).getTime()) / 864e5) + 1;
  if (days > ORDER_EXPORT_MAX_DAYS) {
    throw new AppError(400, 'EXPORT_RANGE_TOO_LONG', `One file covers at most ${ORDER_EXPORT_MAX_DAYS} days. Choose a shorter range.`,
      { days, limit: ORDER_EXPORT_MAX_DAYS });
  }
  return { fromDay, toDay, from: startOfGuyanaDay(fromDay), to: endOfGuyanaDay(toDay), days };
}

const GY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Guyana', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
/** `YYYY-MM-DD HH:mm:ss` on the Guyana clock (a spreadsheet reads it as a date-time). */
export function guyanaStamp(at: Date): string {
  const p = Object.fromEntries(GY.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p['year']}-${p['month']}-${p['day']} ${p['hour']}:${p['minute']}:${p['second']}`;
}
const stamps = (at: Date | null | undefined): [string, string] => (at ? [guyanaStamp(at), at.toISOString()] : ['', '']);

type Money = { toFixed(d: number): string } | null | undefined;
const amount = (v: Money): string => (v == null ? '' : v.toFixed(2));

const yesNo = (v: boolean) => (v ? 'yes' : 'no');
const fixed = (n: number) => n.toFixed(2);

const PAYMENT_METHOD: Record<string, string> = { CASH: 'cash', MOBILE_MONEY: 'mmg', CARD: 'card', BANK_TRANSFER: 'bank_transfer', WALLET: 'wallet' };

function fulfilment(o: { fulfillment: string; fulfillmentMode: string | null }): string {
  if (o.fulfillment === 'APPOINTMENT') return 'appointment';
  if (o.fulfillment === 'PICKUP' || o.fulfillmentMode === 'PICKUP') return 'pickup';
  if (o.fulfillmentMode === 'VENDOR_DELIVERY') return 'own_delivery';
  return 'delivery';
}

/** Where the MMG "paid" claim stands, store first (Swift never holds the money; these are the parties' words). */
function mmgPaidClaim(o: ExportOrder): string {
  if (o.paymentMethod !== 'MOBILE_MONEY') return '';
  if (o.mmgClaimResolution && o.mmgClaimResolvedRevision === o.mmgClaimRevision) {
    return o.mmgClaimResolution === 'CUSTOMER_PAID' ? 'resolved_paid' : 'resolved_not_paid';
  }
  if (o.mmgClaimMismatchAt) return 'disputed';
  if (o.mmgAttestedAt) return 'store_confirmed';
  if (o.customerMmgClaim === 'PAID') return 'customer_says_paid';
  if (o.customerMmgClaim === 'NOT_PAID') return 'customer_says_not_paid';
  return 'not_confirmed';
}

const FINISHED = new Set(['DELIVERED', 'COMPLETED']);

/**
 * [REVIEW-2485-B S3-1] The payment as the receipt words it (order/receipt.ts paidHow): a code for the spreadsheet
 * and the receipt's sentence. Completing a pickup, an appointment or a store's own delivery writes the status only,
 * so cash there is "to the store, not recorded by Swift", never "pending".
 */
function paymentState(o: ExportOrder): [string, string] {
  if (o.paymentStatus === 'REFUNDED') return ['refunded', 'Refunded'];
  if (o.paymentStatus === 'PARTIALLY_REFUNDED') return ['partly_refunded', 'Partly refunded'];
  // [REVIEW-2485-DELTA S4-5] Not cash (no store order takes these today; never called cash if one appears).
  if (o.paymentMethod === 'CARD') return o.paymentStatus === 'CAPTURED' ? ['card_paid', 'Paid by card'] : ['card_pending', 'Card payment, not confirmed'];
  if (o.paymentMethod === 'BANK_TRANSFER') {
    return o.paymentStatus === 'CAPTURED' ? ['bank_transfer_paid', 'Paid by bank transfer'] : ['bank_transfer_pending', 'Bank transfer, not confirmed'];
  }
  if (o.paymentMethod === 'WALLET') return [`wallet_${o.paymentStatus.toLowerCase()}`, 'Wallet'];
  if (o.paymentMethod === 'MOBILE_MONEY') {
    if (o.paymentStatus === 'CAPTURED') return ['mmg_confirmed', 'Paid by MMG — directly to the store'];
    if (o.paymentStatus === 'CLAIMED') return ['mmg_reported_by_store', 'MMG payment reported received by the store — not confirmed by the provider'];
    return ['mmg_pending', 'MMG payment to the store — confirmation pending'];
  }
  const how = fulfilment(o);
  if (o.paymentStatus === 'CAPTURED') {
    // [REVIEW-2485-DELTA S3-2] Handed over short (receipt.ts shortCash): the cash actually taken and what was not.
    const short = o.doorCashShortfallAmount;
    if (short != null && short.gt(0) && o.doorCashCollectedAmount != null) {
      return ['cash_collected_short', `Paid ${amount(o.doorCashCollectedAmount)} in cash on delivery (${amount(short)} not collected)`];
    }
    if (how === 'pickup') return ['cash_collected', 'Paid in cash at the store'];
    if (how === 'appointment') return ['cash_collected', 'Paid at the appointment'];
    return ['cash_collected', 'Paid in cash on delivery'];
  }
  if (o.status === 'CANCELLED') return ['no_payment_recorded', 'Cancelled; no payment recorded by Swift'];
  if (how === 'appointment') return ['cash_to_store_not_recorded_by_swift', 'Cash to the business, not recorded by Swift'];
  if (how === 'pickup' || how === 'own_delivery') return ['cash_to_store_not_recorded_by_swift', 'Cash to the store, not recorded by Swift'];
  if (FINISHED.has(o.status)) return ['cash_not_recorded_by_swift', 'Cash on delivery, not recorded by Swift'];
  return ['cash_due_on_delivery', 'Cash due on delivery'];
}

/** The automatic closes, in the words the store's apps use (@swift/types SYSTEM_CANCELLATION_WORDS, store reader). */
const SYSTEM_CLOSE_WORDS: Readonly<Record<string, string>> = {
  NO_DRIVERS_AVAILABLE: 'No driver was found in time.',
  FOOD_TOO_OLD: 'Too old to deliver: the order was ready but no rider could be found in time.',
  NO_RIDER_FOR_PARCEL: 'No rider was found for this parcel in time.',
};

/** [REVIEW-2485-B S4-5] Who closed the order and why, in plain words (never a code). */
function cancellationWords(by: string, reason: string | null): string {
  switch (by) {
    case 'CUSTOMER': return 'Cancelled by the customer.';
    case 'NO_RESPONSE': return 'The store didn’t respond in time.';
    case 'NO_SHOW': return 'The store recorded that the customer didn’t come.';
    case 'SWIFT': return supportCancellationSentence(reason);
    case 'SYSTEM':
      if (reason && SYSTEM_CANCELLATION_CODES.has(reason)) return SYSTEM_CLOSE_WORDS[reason] ?? 'Closed automatically.';
      return reason ?? 'Closed automatically.';
    default: return reason ?? '';
  }
}

const exportSelect = {
  id: true, orderNumber: true, vendorId: true, customerId: true, status: true, fulfillment: true, fulfillmentMode: true,
  placedAt: true, acceptedAt: true, readyAt: true, deliveredAt: true, cancelledAt: true, cancelledBy: true, cancellationReason: true,
  paymentMethod: true, paymentStatus: true, mmgAttestedRef: true, mmgAttestedAt: true, customerMmgClaim: true,
  mmgClaimMismatchAt: true, mmgClaimResolution: true, mmgClaimResolvedRevision: true, mmgClaimRevision: true,
  subtotalCustomer: true, deliveryFee: true, serviceFee: true, tipAmount: true, discount: true, totalAmount: true,
  vatAmount: true, taxAmount: true, isExpress: true, currencyCode: true,
  refundOwedAmount: true, refundSettledAt: true, refundPaidAmount: true, doorCashCollectedAmount: true, doorCashShortfallAmount: true,
  promoCode: { select: { code: true } },
  promoRedemption: { select: { funder: true, goodsDiscount: true, deliveryDiscount: true, promoCode: { select: { code: true } } } },
} satisfies Prisma.OrderSelect;
type ExportOrder = Prisma.OrderGetPayload<{ select: typeof exportSelect }>;

type Db = PrismaClient;
type Cursor = { placedAt: Date; id: string };

/**
 * One page's filter. [REVIEW-2485-A S3-1] The placed-time range starts AT the cursor (not at the start of the range),
 * so the database starts each page where the last one ended instead of re-reading everything before it; the OR only
 * settles orders placed at the same instant as the cursor (by id).
 */
export function orderExportPageWhere(input: { vendorIds: string[]; from: Date; to: Date }, after: Cursor | null) {
  return {
    vendorId: { in: input.vendorIds },
    placedAt: { gte: after ? after.placedAt : input.from, lte: input.to },
    AND: after ? [{ OR: [{ placedAt: { gt: after.placedAt } }, { placedAt: after.placedAt, id: { gt: after.id } }] }] as Prisma.OrderWhereInput[] : [],
  };
}

/** The CSV, a page of orders at a time: the header first, then one line per order (placed time, then id). */
export async function* orderExportLines(db: Db, input: { vendorIds: string[]; from: Date; to: Date }): AsyncGenerator<string> {
  yield `\uFEFF${ORDER_EXPORT_COLUMNS.join(',')}\r\n`;
  if (input.vendorIds.length === 0) return;
  const stores = new Map((await db.vendor.findMany({ where: { id: { in: input.vendorIds } }, select: { id: true, name: true, city: true } }))
    .map((s) => [s.id, s]));
  let after: Cursor | null = null;
  for (;;) {
    const bounds = orderExportPageWhere(input, after);
    const page: ExportOrder[] = await db.order.findMany({
      where: { ...bounds, AND: [vendorVisibleFilter(db), ...bounds.AND] },
      orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
      take: ORDER_EXPORT_BATCH,
      select: exportSelect,
    });
    if (page.length === 0) return;
    yield await pageLines(db, page, stores);
    if (page.length < ORDER_EXPORT_BATCH) return;
    const last = page[page.length - 1]!;
    after = { placedAt: last.placedAt, id: last.id };
  }
}

async function pageLines(db: Db, page: ExportOrder[], stores: Map<string, { name: string; city: string }>): Promise<string> {
  const ids = page.map((o) => o.id);
  const closedWithoutStamp = page.filter((o) => o.status === 'COMPLETED' && !o.deliveredAt).map((o) => o.id);
  const cancelled = page.filter((o) => o.status === 'CANCELLED');
  const [counts, finished, mmgRefunds, people] = await Promise.all([
    // [REVIEW-2485-B S4-1] A line removed or declined at substitution was never charged (receipt.ts): not counted.
    db.orderItem.groupBy({ by: ['orderId'], where: { orderId: { in: ids }, subStatus: { notIn: ['REFUNDED', 'REJECTED'] } }, _sum: { quantity: true } }),
    closedWithoutStamp.length > 0
      ? db.orderStatusLog.findMany({
        where: { orderId: { in: closedWithoutStamp }, status: { in: ['DELIVERED', 'COMPLETED'] } },
        select: { orderId: true, createdAt: true }, orderBy: { createdAt: 'asc' },
      })
      : [],
    db.mmgRefundObligation.findMany({ where: { orderId: { in: ids }, status: { not: 'VOIDED' } }, select: { orderId: true, amount: true, status: true } }),
    orderPeople(db, cancelled),
  ]);
  const itemCount = new Map(counts.map((c) => [c.orderId, c._sum.quantity ?? 0]));
  const completedAt = new Map<string, Date>();
  for (const row of finished) if (!completedAt.has(row.orderId)) completedAt.set(row.orderId, row.createdAt);
  const refundsByOrder = new Map<string, typeof mmgRefunds>();
  for (const r of mmgRefunds) refundsByOrder.set(r.orderId, [...(refundsByOrder.get(r.orderId) ?? []), r]);

  return page.map((o) => {
    const store = o.vendorId ? stores.get(o.vendorId) : undefined;
    const done = o.deliveredAt ?? completedAt.get(o.id) ?? null;
    const who = customerCancellation(o, people, store?.name ?? '');
    const how = fulfilment(o);
    const [paymentCode, paymentNote] = paymentState(o);
    // [REVIEW-2485-B S2-1] The sales statement's law, per order.
    const money = orderComponents(o);
    const sale = FINISHED.has(o.status);
    const feeAndTip = o.deliveryFee.plus(o.tipAmount);
    const storeKeepsFee = how === 'own_delivery';
    // [REVIEW-2485-B S4-2] Refunds owed (not yet handed back) and paid back, apart.
    let owed = new Prisma.Decimal(0);
    let paid = new Prisma.Decimal(0);
    const notes: string[] = [];
    if (o.refundOwedAmount != null) {
      if (o.refundSettledAt) {
        const back = o.refundPaidAmount ?? o.refundOwedAmount;
        paid = paid.plus(back);
        notes.push(`Refund ${amount(back)}: paid back ${guyanaStamp(o.refundSettledAt).slice(0, 10)}`);
      } else {
        owed = owed.plus(o.refundOwedAmount);
        notes.push(`Refund owed ${amount(o.refundOwedAmount)}: not paid back yet`);
      }
    }
    for (const r of refundsByOrder.get(o.id) ?? []) {
      if (r.status === 'SETTLED' || r.status === 'CONFIRMED') paid = paid.plus(r.amount);
      else owed = owed.plus(r.amount);
      notes.push(`MMG refund ${amount(r.amount)}: ${r.status.toLowerCase()}`);
    }
    if (notes.length === 0 && o.paymentStatus === 'REFUNDED') notes.push('Refunded');
    if (notes.length === 0 && o.paymentStatus === 'PARTIALLY_REFUNDED') notes.push('Partly refunded');
    const anyRefund = o.refundOwedAmount != null || (refundsByOrder.get(o.id)?.length ?? 0) > 0;
    const text = (v: string | null | undefined) => csvTextCell(v ?? '');
    const cells = [
      text(o.orderNumber), text(store?.name), text(store?.city), text(o.status.toLowerCase()), text(how), yesNo(o.isExpress),
      ...stamps(o.placedAt), ...stamps(o.acceptedAt), ...stamps(o.readyAt), ...stamps(done), ...stamps(o.cancelledAt),
      text(PAYMENT_METHOD[o.paymentMethod] ?? o.paymentMethod.toLowerCase()), text(paymentCode), text(paymentNote),
      text(mmgPaidClaim(o)), text(o.paymentMethod === 'MOBILE_MONEY' ? o.mmgAttestedRef : null),
      String(itemCount.get(o.id) ?? 0), text(o.currencyCode),
      amount(o.subtotalCustomer), amount(o.discount),
      // [REVIEW-2485-DELTA S2-1] Who funded the discount counts only on a finished sale (as the statement): a cancelled or
      // unfinished order owes nobody anything. `discount` above stays, as what the order carried.
      ...(sale ? [fixed(money.vendorPromoDiscount), fixed(money.sponsorReceivable), fixed(money.feeFunding), yesNo(money.estimated)] : ['', '', '', '']),
      // [REVIEW-2485-B S3-2] A Swift code spread over a multi-store basket is on the redemption, not on every order.
      text(o.promoRedemption?.promoCode.code ?? o.promoCode?.code),
      amount(o.deliveryFee), amount(o.serviceFee), amount(o.tipAmount), amount(o.taxAmount), amount(o.vatAmount), amount(o.totalAmount),
      sale ? fixed(money.goodsSales - money.vendorPromoDiscount) : '',
      // [REVIEW-2485-DELTA S3-1 · COORD ruling] On its own delivery the store collected the fee less the Swift-funded
      // delivery discount (no rail pays that gap to a store), plus the tip.
      sale ? (storeKeepsFee ? fixed(Math.max(0, Number(feeAndTip) - money.feeFunding)) : '0.00') : '',
      sale ? amount(storeKeepsFee ? new Prisma.Decimal(0) : feeAndTip) : '',
      text(who ? who.by.toLowerCase() : ''), text(who ? cancellationWords(who.by, who.reason) : ''),
      anyRefund && owed.gt(0) ? amount(owed) : '', anyRefund && paid.gt(0) ? amount(paid) : '', text(notes.join('; ')),
    ];
    return `${cells.join(',')}\r\n`;
  }).join('');
}

/**
 * A readable stream of the lines, each page read inside the request's tenant
 * context: the stream is pulled after the handler returns (by the socket), where
 * the request's AsyncLocalStorage store is not guaranteed to follow.
 */
export function orderExportStream(lines: AsyncGenerator<string>): Readable {
  const store = tenantContext.getStore();
  const step = () => (store ? tenantContext.run(store, () => lines.next()) : lines.next());
  return Readable.from((async function* () {
    for (;;) {
      const next = await step();
      if (next.done) return;
      yield next.value;
    }
  })());
}
