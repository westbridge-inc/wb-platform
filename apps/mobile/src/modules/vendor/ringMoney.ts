/**
 * [RING-FOOD · owner bug 11 Nov 2026] The big number on the ringing new-order screen is the STORE's money for the
 * goods — never the customer's whole total. That total carries the rider's delivery fee and tip: a tip is the
 * rider's, and on a Swift-rider order so is the delivery fee.
 *
 *   food = the goods (subtotalCustomer) less the order's discount on them — the conservative reading the sales
 *          statement makes of a discount it cannot attribute (billing/sales-components.ts orderComponents): a
 *          discount never makes the number bigger, and the fee and tip are never in it.
 *
 * Below it, when the order carries a delivery fee or a tip, one plain line says whose it is: the rider's on a
 * Swift-rider order, the store's own when its own rider delivers (the order's recorded choice, else the store's
 * standing "we deliver" setting — the rule acceptance binds with, fulfillment/fulfillment-mode.ts).
 *
 * Plain file, no React Native: the website's takeover imports it as is, so both ring screens say the same.
 */
export interface RingMoneyOrder {
  subtotalCustomer?: unknown;
  discount?: unknown;
  deliveryFee?: unknown;
  tipAmount?: unknown;
  fulfillment?: string | null;
  fulfillmentMode?: string | null;
  vendor?: { vendorType?: string | null; selfDeliveryEnabled?: boolean | null } | null;
}

export interface RingMoney {
  /** "Food" (a restaurant) or "Items" (any other store) — "Service" for a booking. */
  label: string;
  /** The store's goods money; null when the order carried no readable goods amount (the screen shows no number). */
  food: number | null;
  /** Whose the delivery fee and tip are; null when the order has neither (or no rider: a pickup or a booking). */
  note: string | null;
}

/** A wire amount (a number, or a Decimal serialised as a string), or null when it is not a finite number. */
function amount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Who delivers a delivery order: its recorded choice, else the store's standing setting. */
export function ownRiderDelivers(o: RingMoneyOrder): boolean {
  if (o.fulfillmentMode === 'VENDOR_DELIVERY') return true;
  if (o.fulfillmentMode === 'PLATFORM_RIDER') return false;
  return o.vendor?.selfDeliveryEnabled === true;
}

export function ringMoney(o: RingMoneyOrder, storeKind?: string | null): RingMoney {
  const kind = o.vendor?.vendorType ?? storeKind ?? null;
  const label = o.fulfillment === 'APPOINTMENT' || kind === 'SERVICE' ? 'Service' : kind === 'RESTAURANT' ? 'Food' : 'Items';
  const goods = amount(o.subtotalCustomer);
  const discount = Math.max(0, amount(o.discount) ?? 0);
  const food = goods == null ? null : Math.max(0, goods - Math.min(discount, Math.max(0, goods)));

  const fee = Math.max(0, amount(o.deliveryFee) ?? 0);
  const tip = Math.max(0, amount(o.tipAmount) ?? 0);
  let note: string | null = null;
  if ((o.fulfillment ?? 'DELIVERY') === 'DELIVERY' && fee + tip > 0) {
    const what = fee > 0 && tip > 0 ? 'Delivery fee & tip' : tip > 0 ? 'Tip' : 'Delivery fee';
    const plural = fee > 0 && tip > 0;
    note = ownRiderDelivers(o)
      ? `${what} ${plural ? 'are' : 'is'} yours — your rider delivers`
      : `${what} ${plural ? 'go' : 'goes'} to the rider`;
  }
  return { label, food, note };
}
