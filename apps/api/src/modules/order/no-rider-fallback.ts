import { formatMoney } from '../../utils/currency-amount';
import { OWN_RIDER_NOTICE } from './own-rider-notice';
import { readNoMoverFound, type DispatchJournalReader, type NoMoverSubject } from './cancel-policy';

// ---------------------------------------------------------------------------
// [PROD-RIDER-TEST 11 Nov 2026 · COORD ruling (a) under the owner's "just fix these issues"]
// NO RIDER FOUND after the store accepted a delivery: the rider search for the order's current delivery generation
// came back with nobody, and nobody holds it (cancel-policy readNoMoverFound — the same fact that makes the
// customer's cancel free, owner 5 Oct Item 64). Before the free cancel is the only way out:
//  1. the store is asked at once, "No rider found. Deliver it yourselves?" — one tap hands THIS order to the store's
//     own delivery (the per-order fulfilment switch; the customer is told, in OWN_RIDER_NOTICE's words, that the
//     store's own rider brings it), and "Find a rider" still searches again;
//  2. the customer is offered "Switch to pickup" (the existing delivery→pickup conversion: the delivery fee and any
//     rider tip come off), and the free cancel stays, last;
//  3. the store is told plainly when the customer cancels.
// Words only promise what the server does. No money moves through Swift: a cash order is paid at the counter or
// the door, and the conversion only lowers what the customer owes.
// ---------------------------------------------------------------------------

/** The statuses the store may still choose who delivers in (the switch's own window). */
const STORE_CHOICE_STATUSES: ReadonlySet<string> = new Set(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);
/** The statuses the delivery→pickup conversion accepts once the store has accepted. */
const PICKUP_SWITCH_STATUSES: ReadonlySet<string> = new Set(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);

export type NoRiderSubject = {
  orderType: string;
  fulfillment: string | null;
  fulfillmentMode: string | null;
  status: string;
  riderId: string | null;
  vendorId: string | null;
};

/** A store's delivery order (food or shop), not a parcel or a ride: the only kind a store can deliver or hand over. */
function storeDelivery(order: NoRiderSubject): boolean {
  return order.fulfillment === 'DELIVERY' && order.vendorId != null
    && (order.orderType === 'FOOD_DELIVERY' || order.orderType === 'GROCERY_DELIVERY');
}

/** The store may take THIS order to its own delivery with one tap, without the standing self-delivery setting. */
export function storeMayDeliverAfterNoRider(order: NoRiderSubject, noMoverFound: boolean): boolean {
  return noMoverFound && storeDelivery(order) && order.riderId == null
    && order.fulfillmentMode !== 'VENDOR_DELIVERY' && STORE_CHOICE_STATUSES.has(order.status);
}

/** The status-log note when the store takes the order to its own delivery after no rider was found. */
export const NO_RIDER_STORE_DELIVERS_NOTE = 'No rider found: the store chose to deliver this order itself';

/** The store's order card, in its words. */
export const NO_RIDER_STORE_PROMPT = 'No rider found. Deliver it yourselves?';
export const NO_RIDER_STORE_DETAIL = 'One tap and your store delivers this order with its own rider; the customer is told. Or search for a Swift rider again.';

/** What the store's order card and the board read: whether the search for THIS order came back empty while it is
 *  still the store's to choose (no rider, not already the store's own delivery). Additive; older apps ignore it. */
export type NoRiderStoreView = { noRiderFound: boolean; noRiderPrompt: string | null; noRiderDetail: string | null };
const NO_NO_RIDER: NoRiderStoreView = { noRiderFound: false, noRiderPrompt: null, noRiderDetail: null };

export async function noRiderStoreView(db: DispatchJournalReader, order: NoRiderSubject & NoMoverSubject): Promise<NoRiderStoreView> {
  if (!storeDelivery(order) || order.riderId != null || order.fulfillmentMode === 'VENDOR_DELIVERY' || !STORE_CHOICE_STATUSES.has(order.status)) {
    return NO_NO_RIDER;
  }
  if (!(await readNoMoverFound(db, order))) return NO_NO_RIDER;
  return { noRiderFound: true, noRiderPrompt: NO_RIDER_STORE_PROMPT, noRiderDetail: NO_RIDER_STORE_DETAIL };
}

/** The store's push, at the first empty search (once per order state). */
export function noRiderStoreNotice(orderNumber: string): { title: string; body: string } {
  return {
    title: 'No rider found',
    body: `No rider has taken order ${orderNumber}. Deliver it yourselves? Open the order to choose, or search for a rider again.`,
  };
}

/** The customer's push when the store takes the order to its own delivery. */
export function storeDeliversCustomerNotice(orderNumber: string, storeName: string | null | undefined): { title: string; body: string } {
  const store = storeName || 'The store';
  return {
    title: 'The store is delivering your order',
    body: `${store} will deliver order ${orderNumber} itself. ${OWN_RIDER_NOTICE}`,
  };
}

/** The store's push when the customer cancels after no rider was found. */
export function noRiderCancelledStoreNotice(orderNumber: string): { title: string; body: string } {
  return {
    title: 'Customer cancelled the order',
    body: `The customer cancelled order ${orderNumber} after no rider was found. Do not send it out.`,
  };
}

export type PickupSwitchSubject = NoRiderSubject & {
  paymentMethod: string | null;
  deliveryFee: unknown;
  tipAmount: unknown;
  totalAmount: unknown;
  currencyCode?: string | null;
};

/** What the customer's order screen offers before the cancel: collect it instead, with what comes off and what is
 *  left to pay. Null when the conversion route would refuse (an MMG order, a parcel or a ride, a rider on it). */
export type PickupSwitchOffer = {
  deliveryFeeRemoved: number;
  tipRemoved: number;
  newTotal: number;
  message: string;
};

export function pickupSwitchOffer(order: PickupSwitchSubject, noMoverFound: boolean, storeName: string | null | undefined): PickupSwitchOffer | null {
  if (!noMoverFound || !storeDelivery(order) || order.riderId != null) return null;
  if (order.fulfillmentMode === 'VENDOR_DELIVERY' || !PICKUP_SWITCH_STATUSES.has(order.status)) return null;
  // The conversion route refuses every MMG order (the money may already have moved to the store): never offered.
  if (order.paymentMethod !== 'CASH') return null;
  const fee = Number(order.deliveryFee ?? 0);
  const tip = Number(order.tipAmount ?? 0);
  const total = Number(order.totalAmount ?? 0);
  if (![fee, tip, total].every(Number.isFinite)) return null;
  const off = Math.min(fee + tip, total);
  const newTotal = total - off;
  const money = (n: number) => formatMoney(n, order.currencyCode ?? 'GYD', { whole: true });
  const store = storeName || 'the store';
  const removed = tip > 0 ? `the delivery fee and rider tip (${money(off)}) come off` : `the delivery fee (${money(off)}) comes off`;
  return {
    deliveryFeeRemoved: fee,
    tipRemoved: tip,
    newTotal,
    message: `No rider was found. You can collect your order from ${store} instead: ${removed}, so you pay ${money(newTotal)}.`,
  };
}
