import { Readable } from 'node:stream';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { csvTextCell } from '../../utils/csv';
import { guyanaDayKey, isDateOnly, startOfGuyanaDay, endOfGuyanaDay } from '../../utils/guyana-day';
import { vendorVisibleFilter } from '../order/hold-visibility';
import { customerCancellation, orderPeople } from '../order/customer-cancellation';
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
// ---------------------------------------------------------------------------

export const ORDER_EXPORT_AUDIT_ACTION = 'VENDOR_ORDERS_EXPORTED';
/** The longest range one file may cover, in Guyana days (a leap year). */
export const ORDER_EXPORT_MAX_DAYS = 366;
export const ORDER_EXPORT_BATCH = 500;

export const ORDER_EXPORT_COLUMNS = [
  'order_number', 'branch', 'branch_city', 'order_status', 'fulfilment',
  'placed_at_guyana', 'placed_at_iso', 'accepted_at_guyana', 'accepted_at_iso',
  'ready_at_guyana', 'ready_at_iso', 'completed_at_guyana', 'completed_at_iso',
  'cancelled_at_guyana', 'cancelled_at_iso',
  'payment_method', 'payment_status', 'mmg_paid_claim', 'mmg_store_reference',
  'item_count', 'currency', 'food_subtotal', 'delivery_fee', 'service_fee', 'tip', 'discount', 'promo_code',
  'vat_included', 'total', 'cancelled_by', 'cancellation_reason', 'refund_amount', 'refund_note',
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

const exportSelect = {
  id: true, orderNumber: true, vendorId: true, customerId: true, status: true, fulfillment: true, fulfillmentMode: true,
  placedAt: true, acceptedAt: true, readyAt: true, deliveredAt: true, cancelledAt: true, cancelledBy: true, cancellationReason: true,
  paymentMethod: true, paymentStatus: true, mmgAttestedRef: true, mmgAttestedAt: true, customerMmgClaim: true,
  mmgClaimMismatchAt: true, mmgClaimResolution: true, mmgClaimResolvedRevision: true, mmgClaimRevision: true,
  subtotalCustomer: true, deliveryFee: true, serviceFee: true, tipAmount: true, discount: true, totalAmount: true,
  vatAmount: true, currencyCode: true, refundOwedAmount: true, refundSettledAt: true,
  promoCode: { select: { code: true } },
} satisfies Prisma.OrderSelect;
type ExportOrder = Prisma.OrderGetPayload<{ select: typeof exportSelect }>;

type Db = PrismaClient;

/** The CSV, a page of orders at a time: the header first, then one line per order (placed time, then id). */
export async function* orderExportLines(db: Db, input: { vendorIds: string[]; from: Date; to: Date }): AsyncGenerator<string> {
  yield `\uFEFF${ORDER_EXPORT_COLUMNS.join(',')}\r\n`;
  if (input.vendorIds.length === 0) return;
  const stores = new Map((await db.vendor.findMany({ where: { id: { in: input.vendorIds } }, select: { id: true, name: true, city: true } }))
    .map((s) => [s.id, s]));
  let after: { placedAt: Date; id: string } | null = null;
  for (;;) {
    const page: ExportOrder[] = await db.order.findMany({
      where: {
        vendorId: { in: input.vendorIds },
        placedAt: { gte: input.from, lte: input.to },
        AND: [
          vendorVisibleFilter(db),
          ...(after ? [{ OR: [{ placedAt: { gt: after.placedAt } }, { placedAt: after.placedAt, id: { gt: after.id } }] }] : []),
        ],
      },
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
    db.orderItem.groupBy({ by: ['orderId'], where: { orderId: { in: ids } }, _sum: { quantity: true } }),
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
    const refunds = refundsByOrder.get(o.id) ?? [];
    let refundTotal = 0;
    const notes: string[] = [];
    if (o.refundOwedAmount != null) {
      refundTotal += Number(o.refundOwedAmount);
      notes.push(`Refund owed ${amount(o.refundOwedAmount)}: ${o.refundSettledAt ? `paid back ${guyanaStamp(o.refundSettledAt).slice(0, 10)}` : 'not paid back yet'}`);
    }
    for (const r of refunds) {
      refundTotal += Number(r.amount);
      notes.push(`MMG refund ${amount(r.amount)}: ${r.status.toLowerCase()}`);
    }
    if (notes.length === 0 && o.paymentStatus === 'REFUNDED') notes.push('Refunded');
    if (notes.length === 0 && o.paymentStatus === 'PARTIALLY_REFUNDED') notes.push('Partly refunded');
    const text = (v: string | null | undefined) => csvTextCell(v ?? '');
    const cells = [
      text(o.orderNumber), text(store?.name), text(store?.city), text(o.status.toLowerCase()), text(fulfilment(o)),
      ...stamps(o.placedAt), ...stamps(o.acceptedAt), ...stamps(o.readyAt), ...stamps(done), ...stamps(o.cancelledAt),
      text(PAYMENT_METHOD[o.paymentMethod] ?? o.paymentMethod.toLowerCase()), text(o.paymentStatus.toLowerCase()),
      text(mmgPaidClaim(o)), text(o.paymentMethod === 'MOBILE_MONEY' ? o.mmgAttestedRef : null),
      String(itemCount.get(o.id) ?? 0), text(o.currencyCode),
      amount(o.subtotalCustomer), amount(o.deliveryFee), amount(o.serviceFee), amount(o.tipAmount), amount(o.discount),
      text(o.promoCode?.code), amount(o.vatAmount), amount(o.totalAmount),
      text(who ? who.by.toLowerCase() : ''), text(who?.reason),
      notes.length > 0 ? refundTotal.toFixed(2) : '', text(notes.join('; ')),
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
