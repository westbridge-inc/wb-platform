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
 * [STORE-MONEY] A server that sends `storeMoney` (apps/api billing/store-money.ts — the sales statement's law, with
 * the MMG, Swift-discount and own-delivery cases) is the answer: its number and its own words are shown verbatim.
 * The rule above stays only for a server that does not send it yet.
 *
 * Plain file, no React Native: the website imports it as is, so the phone and the website say the same.
 */

/** The server's breakdown, as far as a screen needs it. */
export interface ServerStoreMoney {
  food?: unknown;
  foodWord?: unknown;
  foodLabel?: unknown;
  lines?: unknown;
  /** SWIFT_RIDER · STORE_RIDER · PICKUP · APPOINTMENT */
  delivery?: unknown;
}
export interface RingMoneyOrder {
  subtotalCustomer?: unknown;
  discount?: unknown;
  deliveryFee?: unknown;
  tipAmount?: unknown;
  fulfillment?: string | null;
  fulfillmentMode?: string | null;
  vendor?: { vendorType?: string | null; selfDeliveryEnabled?: boolean | null; [key: string]: unknown } | null;
  storeMoney?: ServerStoreMoney | null;
}

export interface RingMoney {
  /** "Food" (a restaurant) or "Items" (any other store) — "Service" for a booking. */
  label: string;
  /** The store's goods money; null when the order carried no readable goods amount (the screen shows no number). */
  food: number | null;
  /** "Food — you receive": the label beside the number on the order screen. */
  longLabel: string;
  /** Whose the delivery fee and tip are; null when the order has neither (or no rider: a pickup or a booking). */
  note: string | null;
  /** Every plain line under the number, in order (the server's lines when it sent them; else `note` alone). */
  notes: string[];
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

/** The store keeps the delivery fee and tip only when its own rider delivers (the server's word, else the rule). */
export function storeKeepsDelivery(o: RingMoneyOrder): boolean {
  if ((o.fulfillment ?? 'DELIVERY') !== 'DELIVERY') return false;
  const said = o.storeMoney?.delivery;
  return typeof said === 'string' ? said === 'STORE_RIDER' : ownRiderDelivers(o);
}

/** The server's breakdown, when it is well formed; null otherwise (an older server, or a malformed payload). */
function serverMoney(o: RingMoneyOrder): RingMoney | null {
  const m = o.storeMoney;
  if (!m || typeof m !== 'object') return null;
  const food = amount(m.food);
  if (food == null || typeof m.foodWord !== 'string' || !m.foodWord.trim()) return null;
  const notes = Array.isArray(m.lines) ? m.lines.filter((l): l is string => typeof l === 'string' && l.trim() !== '') : [];
  const longLabel = typeof m.foodLabel === 'string' && m.foodLabel.trim() ? m.foodLabel : `${m.foodWord} — you receive`;
  return { label: m.foodWord, longLabel, food, note: notes[0] ?? null, notes };
}

export function ringMoney(o: RingMoneyOrder, storeKind?: string | null): RingMoney {
  const fromServer = serverMoney(o);
  if (fromServer) return fromServer;
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
  return { label, longLabel: `${label} — you receive`, food, note, notes: note ? [note] : [] };
}
