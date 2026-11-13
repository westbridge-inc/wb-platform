// ---------------------------------------------------------------------------
// [UI-SWEEP U02 / U25 / U45] The store's order window, in the phone's words
// (apps/mobile/src/modules/vendor/shared.tsx OrderStatusPill,
// screens/VendorOrderDetailScreen.tsx). Pure, so it tests without a renderer.
// ---------------------------------------------------------------------------

import { formatAppointmentSlot } from './appointmentTime';
import { storeOrderStatusWords } from '@swift/types/src/order-words';
import type { VendorOrder } from './vendor-api';
import { promisedTimeName } from './store-kind-words';
import { orderVatAddedRow } from './store-vat-display';
// [STORE-MONEY] The app's own reader of the store's money (plain file, imported as is).
import { ringMoney, storeKeepsDelivery } from '../../../mobile/src/modules/vendor/ringMoney';

/** The phone's pill words, from the one shared map (@swift/types order-words).
 *  A status this build does not know reads "Status unavailable", never the code. */
export function vendorStatusLabel(status: string | null | undefined): string {
  return storeOrderStatusWords(status);
}

/** The money card: recorded amounts only. Optional lines show only when the order carries them.
 *  [STORE-MONEY · owner 11 Nov 2026] It ends on the STORE's money (the food, after its own discount) — never on the
 *  customer's total, which carries the rider's delivery fee and tip. The phone's card says the same. */
export function orderMoneyRows(o: VendorOrder): Array<{ label: string; value: number | null; minus?: boolean; strong?: boolean }> {
  const sm = ringMoney(o);
  const yours = storeKeepsDelivery(o);
  const rows: Array<{ label: string; value: number | null; minus?: boolean; strong?: boolean }> = [{ label: 'Items', value: o.subtotalBase ?? null }];
  if ((o.deliveryFee ?? 0) > 0) rows.push({ label: yours ? 'Delivery fee (yours)' : 'Delivery fee (rider’s)', value: o.deliveryFee ?? null });
  if ((o.tipAmount ?? 0) > 0) rows.push({ label: yours ? 'Tip (yours)' : 'Tip (rider’s)', value: o.tipAmount ?? null });
  if ((o.discount ?? 0) > 0) rows.push({ label: 'Promo discount', value: o.discount ?? null, minus: true });
  // [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] A store pricing before VAT: the VAT added at checkout (the store's).
  const vat = orderVatAddedRow(o);
  if (vat) rows.push({ label: `${vat.label} (yours, for the GRA)`, value: vat.amount });
  rows.push({ label: 'Customer pays', value: o.totalAmount });
  rows.push({ label: sm.longLabel, value: sm.food, strong: true });
  return rows;
}

/** [STORE-MONEY] The plain lines under the money card: whose the fee and tip are, what Swift pays (server words). */
export function orderMoneyNotes(o: VendorOrder): string[] {
  return ringMoney(o).notes;
}


/** The line under the money card: how this order is paid. A method with no
 *  line of its own gets none: a card order must never read as cash. */
export function orderPaymentLine(o: VendorOrder): string | null {
  if (o.paymentMethod === 'CASH') return 'Cash on handover — you keep 100% of the goods total.';
  if (o.paymentMethod === 'MOBILE_MONEY') return 'MMG — the customer pays your store’s MMG account.';
  return null;
}

/** The Customer card's lines: where the order goes (phone ContactCard lines). */
export function customerLines(o: VendorOrder): string[] {
  if (o.fulfillment === 'APPOINTMENT') {
    const travels = !!o.deliveryAddress && o.deliveryAddress !== o.pickupAddress;
    return [
      ...(o.appointmentSlot ? [formatAppointmentSlot(o.appointmentSlot)] : []),
      travels ? `You travel to: ${o.deliveryAddress}` : 'At your store',
    ];
  }
  if (o.fulfillment === 'PICKUP') return ['Collects at the counter'];
  return [o.deliveryAddress, o.deliveryInstructions].filter((l): l is string => typeof l === 'string' && l.trim() !== '');
}

/** A `tel:` target only for something that is a phone number. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = typeof phone === 'string' ? phone.replace(/[^\d+]/g, '') : '';
  return /^\+?\d{5,}$/.test(digits) ? `tel:${digits}` : null;
}

/** "Quoted prep time: 20 min · actual 18 min (ready 1:05 PM)" — the phone's line. [STORE-WORDS sweep] "prep time" only
 *  for a restaurant; any other store quoted a "ready time". */
export function prepTimeLine(o: VendorOrder): string | null {
  if (!o.estimatedPrepTime) return null;
  const ready = o.readyAt ? Date.parse(o.readyAt) : NaN;
  const accepted = o.acceptedAt ? Date.parse(o.acceptedAt) : NaN;
  const actual = Number.isFinite(ready) && Number.isFinite(accepted)
    ? ` · actual ${Math.max(1, Math.round((ready - accepted) / 60000))} min (ready ${new Date(ready).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Guyana' })})`
    : '';
  return `Quoted ${promisedTimeName(o.vendor?.vendorType)}: ${o.estimatedPrepTime} min${actual}`;
}

/** "18 Oct, 1:05 PM" for the timeline and the cancellation line. */
export function whenLabel(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Guyana' });
}

export interface RecoveryView { caseId: string; state: string; open: boolean; headline: string; body: string }

/** [AF-MOB-006] The order's recovery case as the server wrote it; anything malformed is no card. */
export function recoveryView(raw: unknown): RecoveryView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const caseId = str(r['caseId']); const state = str(r['state']); const headline = str(r['headline']); const body = str(r['body']);
  if (!caseId || !state || !headline || !body) return null;
  const view = { caseId, state, open: r['open'] === true, headline, body };
  // A resolved DELIVERED or CLOSED case only repeats the order screen (phone partyCaseWorthShowing).
  return view.open || state === 'RETURNED' || state === 'TRANSFERRED' ? view : null;
}

/** The store's one recovery action: the returned goods are back (phone storeCanConfirmReturn). */
export function storeCanConfirmReturn(view: RecoveryView | null, o: VendorOrder): boolean {
  return !!view && view.state === 'RETURN_REQUIRED' && String(o.status).toUpperCase() === 'RETURNING' && o.orderType !== 'COURIER';
}

/** [PERF row 562] What a store tap's answer confirms about its order (status and its clocks). */
export const CONFIRMED_ORDER_FIELDS = ['status', 'acceptedAt', 'preparingAt', 'readyAt', 'estimatedPrepTime', 'deliveredAt', 'completedAt', 'handedToRiderAt'] as const;

/** The fields the server just confirmed for order `id` in a step's answer (the bare updated row),
 *  or null when the answer is not that order's row. Nothing else is taken from it. */
export function confirmedOrderFields(answer: unknown, id: string): Partial<VendorOrder> | null {
  const row = (answer as { data?: Record<string, unknown> } | undefined)?.data;
  if (!row || row['id'] !== id || typeof row['status'] !== 'string') return null;
  return Object.fromEntries(CONFIRMED_ORDER_FIELDS.filter((key) => key in row).map((key) => [key, row[key]])) as Partial<VendorOrder>;
}
