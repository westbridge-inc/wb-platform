import type { KitchenEvent, KitchenEventKind, KitchenOrder } from '../kitchen-provider';
import { KITCHEN_MAX_ETA_SECONDS, type DragontailSettings } from '../kitchen-switch';

/**
 * [KITCHEN-INTEGRATION] Swift ⇄ Dragontail field mapping, from the public POS API spec (v1.1.0) only. Pure
 * functions: the contract test snapshots their output field by field against the spec.
 *
 * Spec facts this relies on (quoted from the schema):
 *   Order required: storeNo, orderId, dailyNo, orderTime, saleType.
 *   orderTime: "ISO Formatted YYYY-MM-DD hh:mm:ss … otherwise, the current time".
 *   saleType: 1 Takeaway/carryout, 2 Delivery, 3 Dine in.
 *   paymentMethod: 0 cash, 1 credit, 2 other1, 3 other2.
 *   isNotPaid: 0 paid, 1 not paid.  tips: "Prepaid courier tips".  cash: "total amount of cash in the ticket".
 *   source: 1 store, 2 online, 3 mobile, "Custom source types can be configured".
 *   OrderItem required: StoreNo, OrderId, Position, OrderStatus, ItemsActions, ItemNo, Quantity, Description, Side.
 *   Position: '001' for a top-level item, '001001' for its first sub-item.
 *   Side: 3 = main item (default), 0 = modifier/topping.
 *   ItemsActions: 0 AddNewItem, 1 ChangeInItem, 2 ItemRemoveFromBill. Action (same codes; "If Action node is missing,
 *   the ALGO treats all actions as 'add'"): sent too, with the same value, so a removal is never read as an add.
 *   cookInstructions: maxLength 150.
 *   OrderStatus (order status codes): 0 NewOrderMakeline.
 *   Request required: time, storeNo, fullLoad, orders, ordersItems, translations.
 *
 * TODO-CONFIRM (the spec disagrees with itself; the schema wins here, the example differs):
 *   - the items array is `ordersItems` in the schema, `orderItems` in the example;
 *   - OrderItem fields are PascalCase in the schema, camelCase in the example;
 *   - login's token is typed integer, its example is a string;
 *   - the time zone of orderTime (Swift sends Guyana local time, UTC-4, no daylight saving).
 */

/** Guyana local time, YYYY-MM-DD hh:mm:ss (UTC-4 all year). */
export function dragontailTime(at: Date): string {
  const local = new Date(at.getTime() - 4 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 19).replace('T', ' ');
}

export const DRAGONTAIL_SALE_TYPE = { TAKEAWAY: 1, DELIVERY: 2 } as const;
export const DRAGONTAIL_SIDE_MAIN = 3;
export const DRAGONTAIL_SIDE_MODIFIER = 0;
export const DRAGONTAIL_ITEMS_ACTION = { ADD: 0, CHANGE: 1, REMOVE: 2 } as const;
export const DRAGONTAIL_ORDER_STATUS_NEW = 0;

const pos = (n: number) => String(n).padStart(3, '0');
const clip = (s: string | null | undefined, max: number): string | undefined => {
  const t = (s ?? '').trim();
  return t ? t.slice(0, max) : undefined;
};

type ItemsAction = (typeof DRAGONTAIL_ITEMS_ACTION)[keyof typeof DRAGONTAIL_ITEMS_ACTION];

/** The OrderItem rows for an order: each line at '001', '002' …, its choices at '001001', '001002' …. */
export function dragontailItems(order: KitchenOrder, itemsAction: ItemsAction) {
  const rows: Array<Record<string, unknown>> = [];
  order.lines.forEach((line, i) => {
    const position = pos(i + 1);
    rows.push({
      StoreNo: order.storeNo,
      OrderId: order.externalOrderId,
      Position: position,
      OrderStatus: DRAGONTAIL_ORDER_STATUS_NEW,
      ItemsActions: itemsAction,
      Action: itemsAction,
      ItemNo: line.itemNo,
      Quantity: line.quantity,
      Description: line.name.slice(0, 120),
      Side: DRAGONTAIL_SIDE_MAIN,
    });
    line.choices.forEach((choice, j) => {
      rows.push({
        StoreNo: order.storeNo,
        OrderId: order.externalOrderId,
        Position: `${position}${pos(j + 1)}`,
        OrderStatus: DRAGONTAIL_ORDER_STATUS_NEW,
        ItemsActions: itemsAction,
        Action: itemsAction,
        ItemNo: choice.itemNo,
        Quantity: 1,
        Description: choice.name.slice(0, 120),
        Side: DRAGONTAIL_SIDE_MODIFIER,
      });
    });
  });
  return rows;
}

/** The cook instructions: the order-level note, then each line's own note, named by the line. */
function cookInstructions(order: KitchenOrder): string | undefined {
  const parts = [order.cookNote, ...order.lines.filter((l) => l.note).map((l) => `${l.name}: ${l.note}`)];
  // [review B S3-5] The spec's maxLength is 150: longer would be a validationError (and a tablet fallback every time).
  return clip(parts.filter(Boolean).join(' | '), 150);
}

/** The Order row. A first name always (never the last name); for a delivery, the phone, the address, location and
 *  the driver note (owner ruling 12 Nov 2026: the store's own driver must reach the customer); a takeaway carries the
 *  first name only. */
export function dragontailOrder(order: KitchenOrder, settings: Pick<DragontailSettings, 'sourceId' | 'mmgPaymentCode'>) {
  const delivery = order.saleType === 'DELIVERY';
  const row: Record<string, unknown> = {
    storeNo: order.storeNo,
    orderId: order.externalOrderId,
    dailyNo: order.dailyNo,
    orderTime: dragontailTime(order.placedAt),
    saleType: DRAGONTAIL_SALE_TYPE[order.saleType],
    isTimedOrder: 0,
    source: settings.sourceId,
    paymentMethod: order.payment === 'CASH' ? 0 : settings.mmgPaymentCode,
    cash: order.cashToCollect,
    orderTotal: order.orderTotal,
    netSales: order.netSales,
    tips: order.prepaidTips,
    isNotPaid: order.isPaid ? 0 : 1,
  };
  const firstName = clip(order.customer.firstName, 60);
  if (firstName) row['firstName'] = firstName;
  if (delivery) {
    const phone = clip(order.customer.phone, 32);
    const street = clip(order.customer.address, 250);
    if (phone) row['phone'] = phone;
    if (street) row['street'] = street;
    if (order.customer.lat !== null) row['lat'] = order.customer.lat;
    if (order.customer.lng !== null) row['lng'] = order.customer.lng;
    const driverNote = clip(order.driverNote, 500);
    if (driverNote) row['carrierInstructions'] = driverNote;
  }
  const cook = cookInstructions(order);
  if (cook) row['cookInstructions'] = cook;
  return row;
}

/** POST /PosInsertOrders body for an insert (ADD) or an update (CHANGE) of one order. */
export function dragontailInsertBody(
  order: KitchenOrder,
  settings: Pick<DragontailSettings, 'sourceId' | 'mmgPaymentCode'>,
  swiftOrderNumber: string,
  itemsAction: ItemsAction = DRAGONTAIL_ITEMS_ACTION.ADD,
  now: Date = new Date(),
) {
  return {
    time: dragontailTime(now),
    storeNo: order.storeNo,
    fullLoad: false,
    // The spec's optional alternative id: Swift's own order number, so the kitchen and the Swift tablet name the
    // order the same way. TODO-CONFIRM where Dragontail shows it.
    AltOrderId: swiftOrderNumber,
    orders: [dragontailOrder(order, settings)],
    ordersItems: dragontailItems(order, itemsAction),
    translations: [],
  };
}

/** POST /PosInsertOrders body that cancels an order (DRAGONTAIL_CANCEL_MODE). */
export function dragontailCancelBody(
  order: KitchenOrder,
  settings: Pick<DragontailSettings, 'sourceId' | 'mmgPaymentCode' | 'cancelMode' | 'orderIdBase'>,
  swiftOrderNumber: string,
  refundTicketId: number,
  now: Date = new Date(),
) {
  if (settings.cancelMode === 'REMOVE_ITEMS') {
    return dragontailInsertBody(order, settings, swiftOrderNumber, DRAGONTAIL_ITEMS_ACTION.REMOVE, now);
  }
  // A refund ticket: "if the ticket is a refund/storno for another ticket both tickets would be cancelled".
  const refund: KitchenOrder = { ...order, externalOrderId: refundTicketId, lines: [] };
  return {
    time: dragontailTime(now),
    storeNo: order.storeNo,
    fullLoad: false,
    AltOrderId: swiftOrderNumber,
    orders: [{ ...dragontailOrder(refund, settings), refundFor: String(order.externalOrderId) }],
    ordersItems: [],
    translations: [],
  };
}

/** The spec's notification actions, in Swift's words. Anything else is IGNORED (logged, never a crash). */
const ACTIONS: Record<string, KitchenEventKind> = {
  ReachedTheMakeLine: 'MAKE_LINE',
  Prepared: 'PREPARED',
  Cook: 'COOKED',
  Pack: 'PACKED',
  Dispatched: 'DISPATCHED',
  ETA: 'ETA',
  Delivered: 'DELIVERED',
  Unassigned: 'UNASSIGNED',
  Undelivered: 'UNDELIVERED',
  PrintRequest: 'IGNORED',
  BackToStore: 'BACK_TO_STORE',
};

/** "2016-04-19 13:08:19" in Guyana local time → a Date; null when unreadable. */
export function parseDragontailTime(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  // A step not reached yet may come back empty or as a zero date: that is "not yet", never an event.
  if (!m || +m[1]! < 2000) return null;
  const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) + 4 * 60 * 60 * 1000;
  return Number.isFinite(at) ? new Date(at) : null;
}

const asInt = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
};

/** One Notification object → a KitchenEvent, or null when it is not a notification at all. */
export function dragontailEvent(raw: unknown): KitchenEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const storeNo = asInt(n['storeNo']);
  const externalOrderId = asInt(n['orderId']);
  const action = typeof n['action'] === 'string' ? n['action'] : null;
  if (storeNo === null || externalOrderId === null || !action) return null;
  const eta = asInt(n['ETASeconds'] ?? n['etaSeconds']);
  return {
    storeNo,
    externalOrderId,
    action: action.slice(0, 40),
    // [review A S4-3] own keys only: 'constructor' or '__proto__' is an unknown action, not an inherited object
    kind: Object.hasOwn(ACTIONS, action) ? ACTIONS[action]! : 'IGNORED',
    at: parseDragontailTime(n['actionTime']),
    // [review A S4-2] capped: an estimate beyond six hours is taken as six hours, never months
    etaSeconds: eta !== null && eta >= 0 ? Math.min(eta, KITCHEN_MAX_ETA_SECONDS) : null,
  };
}

/** A PosNotification / GetPosNotification body ({ time, orders: Notification[] }) → events. */
export function dragontailEvents(body: unknown): KitchenEvent[] {
  const orders = body && typeof body === 'object' ? (body as { orders?: unknown }).orders : undefined;
  if (!Array.isArray(orders)) return [];
  return orders.slice(0, 500).map(dragontailEvent).filter((e): e is KitchenEvent => e !== null);
}

/** The most GetOrderUpdatesForPos rows read from one answer. The answer carries everything since the stamp (the
 *  store's own POS orders too, a whole working day at stamp 0), and the cursor moves past all of it, so the bound is
 *  generous: Swift's own orders among them are picked out before anything touches the database. */
export const DRAGONTAIL_MAX_UPDATE_ROWS = 20_000;

/**
 * GetOrderUpdatesForPos rows ({ orders: [{ storeNo, orderId, reachedTheMakeLineTime, preparationTime, cookedTime,
 * packTime, dispatchTime, deliveryTime, … }] }) → the events their timestamps imply, in kitchen order, each row
 * first as a SEEN event (the kitchen knows this order: it confirms an insert whose answer was lost). This is the
 * catch-up for a missed webhook: replaying an event Swift already applied changes nothing (the state machine
 * refuses a step backwards or a step twice).
 */
export function dragontailUpdateEvents(body: unknown): KitchenEvent[] {
  const orders = body && typeof body === 'object' ? (body as { orders?: unknown }).orders : undefined;
  if (!Array.isArray(orders)) return [];
  const steps: Array<[string, KitchenEventKind, string]> = [
    ['reachedTheMakeLineTime', 'MAKE_LINE', 'ReachedTheMakeLine'],
    ['preparationTime', 'PREPARED', 'Prepared'],
    ['cookedTime', 'COOKED', 'Cook'],
    ['packTime', 'PACKED', 'Pack'],
    ['dispatchTime', 'DISPATCHED', 'Dispatched'],
    ['deliveryTime', 'DELIVERED', 'Delivered'],
    // [review B S3-9] back at the store: after a Delivered it changes nothing; without one, operations are paged
    ['backToStoreTime', 'BACK_TO_STORE', 'BackToStore'],
  ];
  const out: KitchenEvent[] = [];
  for (const raw of orders.slice(0, DRAGONTAIL_MAX_UPDATE_ROWS)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const storeNo = asInt(row['storeNo']);
    const externalOrderId = asInt(row['orderId']);
    if (storeNo === null || externalOrderId === null) continue;
    out.push({ storeNo, externalOrderId, kind: 'SEEN', action: 'OrderUpdate', at: null, etaSeconds: null });
    for (const [field, kind, action] of steps) {
      const at = parseDragontailTime(row[field]);
      if (at) out.push({ storeNo, externalOrderId, kind, action, at, etaSeconds: null });
    }
  }
  return out;
}
