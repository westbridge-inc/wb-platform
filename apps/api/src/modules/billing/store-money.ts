import type { PrismaClient } from '@prisma/client';
import { orderComponents, type OrderMoneyRow } from './sales-components';
import { resolveDeliveryMode } from '../fulfillment/fulfillment-mode';
import { formatMoney } from '../../utils/currency-amount';

/**
 * [STORE-MONEY · owner bug 11 Nov 2026] What a store sees as ITS money on an order.
 *
 * The store's ringing new-order screen showed `order.totalAmount` — the customer's whole total, the rider's
 * delivery fee and tip included — as if the store were getting it. A tip is the rider's, never the store's.
 *
 * One server-computed answer, from the SAME law as the sales statement (`orderComponents`, sales-components.ts):
 *
 *   food         goods after the store's OWN discount (goodsSales − vendorPromoDiscount) — the big number.
 *   swiftPaysYou a Swift-funded goods discount: the customer paid less, Swift owes the store this part of `food`.
 *
 * and the delivery money, by who delivers and how the customer pays (fulfillment/money-matrix.ts rows):
 *
 *   Swift rider + cash   the rider hands the store the food money at pickup and collects the rest at the door:
 *                        the delivery fee + tip are the rider's (`riderFeeAndTip`), never the store's.
 *   Swift rider + MMG    the customer pays the store the whole total (`customerPaysYou`) by MMG; the store owes the
 *                        rider the delivery fee + tip (`riderFeeAndTip`, the delivery-cash-settlement amount).
 *   store's own rider    the store keeps the delivery fee + tip, less any Swift-funded delivery discount
 *                        (`yoursFeeAndTip`) — the customer never paid that part.
 *   pickup               the food only; no rider, no fee, no tip.
 *   appointment          the business's own visit: anything charged on top is the business's.
 *
 * `lines` are the plain words under the big number, written here once so the phone app and the website say the same.
 * Swift moves none of this money; this only says whose it is.
 */
export type StoreMoneyDelivery = 'SWIFT_RIDER' | 'STORE_RIDER' | 'PICKUP' | 'APPOINTMENT';

export interface StoreMoney {
  /** The store's money for the goods (after its own discount): the number a store screen shows big. */
  food: number;
  /** What to call it: "Food — you receive" (a restaurant), "Items — you receive", "Service — you receive". */
  foodLabel: string;
  /** Part of `food` Swift pays (a Swift-funded discount); 0 when none. */
  swiftPaysYou: number;
  delivery: StoreMoneyDelivery;
  payment: 'CASH' | 'MMG' | 'OTHER';
  /** The Swift rider's delivery fee + tip (never the store's). 0 unless a Swift rider delivers. */
  riderFeeAndTip: number;
  /** The delivery fee + tip the store keeps (its own rider, or its own visit). 0 otherwise. */
  yoursFeeAndTip: number;
  /** The whole amount the customer pays the store directly (MMG with a Swift rider); null when it is not that case. */
  customerPaysYou: number | null;
  /** Plain words under the big number, in order. Empty when there is nothing to add. */
  lines: string[];
}

export interface StoreMoneyOrder extends OrderMoneyRow {
  orderType?: string | null;
  fulfillment?: string | null;
  fulfillmentMode?: string | null;
  paymentMethod?: string | null;
  totalAmount: unknown;
  currencyCode?: string | null;
  vendor?: { vendorType?: string | null; selfDeliveryEnabled?: boolean | null } | null;
}

/** The columns `storeMoney` reads (a Prisma select). The vendor's two columns ride the order's own vendor select. */
export const STORE_MONEY_SELECT = {
  orderType: true, fulfillment: true, fulfillmentMode: true, paymentMethod: true, currencyCode: true,
  subtotalCustomer: true, discount: true, deliveryFee: true, tipAmount: true, totalAmount: true,
  promoRedemption: { select: { goodsDiscount: true, deliveryDiscount: true, funder: true } },
  vendor: { select: { vendorType: true, selfDeliveryEnabled: true } },
} as const;

const num = (v: unknown) => Math.max(0, Number(v ?? 0) || 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The store screens' own money spelling ("$1,500" for GYD, like the app's money()); another currency names itself. */
function amountWords(n: number, currency: string): string {
  return currency === 'GYD'
    ? `$${Math.round(n).toLocaleString('en-US')}`
    : formatMoney(n, currency, { whole: true });
}

function goodsWord(order: StoreMoneyOrder): string {
  if (order.fulfillment === 'APPOINTMENT' || order.vendor?.vendorType === 'SERVICE') return 'Service';
  return order.vendor?.vendorType === 'RESTAURANT' ? 'Food' : 'Items';
}

/** "delivery fee & tip" / "delivery fee" / "tip" — only what the order carries. */
function feeTipWords(fee: number, tip: number): string {
  if (fee > 0 && tip > 0) return 'delivery fee & tip';
  return tip > 0 ? 'tip' : 'delivery fee';
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function deliveryOf(order: StoreMoneyOrder): StoreMoneyDelivery {
  if (order.fulfillment === 'PICKUP' || order.fulfillmentMode === 'PICKUP') return 'PICKUP';
  if (order.fulfillment === 'APPOINTMENT') return 'APPOINTMENT';
  // A delivery order: who delivers is the order's own recorded choice, else the store's standing preference — the
  // exact rule acceptance binds with (fulfillment-mode.ts resolveDeliveryMode).
  return resolveDeliveryMode(
    order.fulfillmentMode === 'VENDOR_DELIVERY' || order.fulfillmentMode === 'PLATFORM_RIDER' ? order.fulfillmentMode : null,
    order.vendor?.selfDeliveryEnabled === true,
  ) === 'VENDOR_DELIVERY' ? 'STORE_RIDER' : 'SWIFT_RIDER';
}

/** The store's money on one order, or null for an order that is not a store's (a parcel or a ride). */
export function storeMoney(order: StoreMoneyOrder): StoreMoney | null {
  if (order.orderType === 'COURIER' || order.orderType === 'TAXI') return null;
  const c = orderComponents(order);
  const currency = order.currencyCode || 'GYD';
  const amt = (n: number) => amountWords(n, currency);
  const fee = num(order.deliveryFee);
  const tip = num(order.tipAmount);
  const total = num(order.totalAmount);
  const delivery = deliveryOf(order);
  const payment: StoreMoney['payment'] = order.paymentMethod === 'CASH' ? 'CASH' : order.paymentMethod === 'MOBILE_MONEY' ? 'MMG' : 'OTHER';
  const word = goodsWord(order);

  const food = round2(c.goodsSales - c.vendorPromoDiscount);
  let swiftPaysYou = c.sponsorReceivable;
  let riderFeeAndTip = 0;
  let yoursFeeAndTip = 0;
  let customerPaysYou: number | null = null;
  const lines: string[] = [];

  if (delivery === 'SWIFT_RIDER') {
    riderFeeAndTip = round2(fee + tip); // exactly what createEarnings books the rider, and an MMG settlement's amount
    if (payment === 'CASH') {
      if (riderFeeAndTip > 0) lines.push(`Rider's ${feeTipWords(fee, tip)}: ${amt(riderFeeAndTip)} (not yours)`);
    } else {
      // The customer pays the store the whole total; the store pays the rider's part on. A Swift-funded delivery
      // discount lowered what the customer paid but not what the rider is owed: Swift pays the store that gap.
      customerPaysYou = round2(total);
      swiftPaysYou = round2(swiftPaysYou + c.feeFunding);
      const how = payment === 'MMG' ? 'by MMG' : 'directly';
      lines.push(riderFeeAndTip > 0
        ? `Customer pays you ${amt(customerPaysYou)} ${how} — ${amt(riderFeeAndTip)} of it is the rider's, pay it at pickup`
        : `Customer pays you ${amt(customerPaysYou)} ${how}`);
    }
  } else if (delivery === 'STORE_RIDER' || delivery === 'APPOINTMENT') {
    yoursFeeAndTip = round2(Math.max(0, fee - c.feeFunding) + tip);
    if (yoursFeeAndTip > 0) {
      lines.push(delivery === 'STORE_RIDER'
        ? `${capitalised(feeTipWords(fee, tip))}: ${amt(yoursFeeAndTip)} (yours — your rider delivers)`
        : `${capitalised(feeTipWords(fee, tip).replace('delivery fee', 'visit fee'))}: ${amt(yoursFeeAndTip)} (yours)`);
    }
  }
  if (swiftPaysYou > 0) lines.push(`Swift pays you ${amt(swiftPaysYou)} (a Swift discount the customer got)`);

  return {
    food, foodLabel: `${word} — you receive`, swiftPaysYou: round2(swiftPaysYou), delivery, payment,
    riderFeeAndTip, yoursFeeAndTip, customerPaysYou, lines,
  };
}

/** One order's store money, read by id (the new-order push). Null when the order is gone or is not a store's. */
export async function loadStoreMoney(prisma: Pick<PrismaClient, 'order'>, orderId: string): Promise<StoreMoney | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: STORE_MONEY_SELECT });
  return order ? storeMoney(order) : null;
}

/** The redemption snapshots for a page of orders, in one read — the board and the detail attach `storeMoney` with it. */
export async function redemptionsFor(
  prisma: Pick<PrismaClient, 'promoRedemption'>,
  orderIds: readonly string[],
): Promise<Map<string, OrderMoneyRow['promoRedemption']>> {
  if (orderIds.length === 0) return new Map();
  const rows = await prisma.promoRedemption.findMany({
    where: { orderId: { in: [...orderIds] } },
    select: { orderId: true, goodsDiscount: true, deliveryDiscount: true, funder: true },
  });
  return new Map(rows.map((r) => [r.orderId, { goodsDiscount: r.goodsDiscount, deliveryDiscount: r.deliveryDiscount, funder: r.funder }]));
}
