/**
 * What the store is told about an MMG order's payment, in one place for the
 * board's cards and the order window.
 *
 * Money has moved when the provider captured it (CAPTURED) or the store has
 * reported it landed (CLAIMED — the store's own report is never recorded
 * as CAPTURED). The server lets both proceed (order.service.ts
 * MMG_MONEY_MOVED).
 */
// [REVIEW-F S4-2 on #2032] One money-moved set for the phone and the web (plain app file, imported as is).
export { MMG_MONEY_MOVED } from '../../../mobile/src/modules/vendor/storeOrderRules';
import { MMG_MONEY_MOVED } from '../../../mobile/src/modules/vendor/storeOrderRules';
import { canAttestPayment } from './vendor-hub';
export function mmgMoneyMoved(paymentStatus: string | null | undefined): boolean {
  return (MMG_MONEY_MOVED as readonly string[]).includes(String(paymentStatus ?? ''));
}

type MmgAcceptFacts = { paymentMethod?: string | null; paymentStatus?: string | null; mmgAttestedRef?: string | null };

/** An MMG order whose payment has not moved but still can: open (PENDING, AUTHORIZED) and no store claim an operator
 *  rejected (that reference stays on the reopened order, and such an order can never be paid). */
function mmgPaymentStillOpen(order: MmgAcceptFacts): boolean {
  return order.paymentMethod === 'MOBILE_MONEY' && !mmgMoneyMoved(order.paymentStatus)
    && canAttestPayment(order.paymentStatus) && order.mmgAttestedRef == null;
}

/**
 * THE rule for every place the web can accept an order (the board card, the
 * new-order popup, the order window). [owner 14 Nov 2026 · option A, with the
 * API's PAYMENT-SIMPLIFY Q1] Accept comes BEFORE payment on an MMG order: the
 * customer sees the store's MMG number only once the store accepts, and nothing
 * moves past Accept until the store taps "Paid by MMG". So Accept is held back
 * only where the server refuses it (order.service.ts assertMmgFulfilmentAllowed):
 * an MMG payment that has not moved and can no longer happen here.
 */
export function acceptHeldForPayment(order: MmgAcceptFacts): boolean {
  return order.paymentMethod === 'MOBILE_MONEY' && !mmgMoneyMoved(order.paymentStatus) && !mmgPaymentStillOpen(order);
}

/** [owner 14 Nov 2026] What the store is told beside Accept on an unpaid MMG order (owner-approved words). */
export const MMG_PAY_AFTER_ACCEPT = 'The customer pays your MMG number after you accept, so tap Paid by MMG when it lands.';

/** An unpaid MMG order Accept is offered on: the customer pays after the store accepts. */
export function paysAfterAccept(order: MmgAcceptFacts): boolean {
  return mmgPaymentStillOpen(order);
}

/** What a moved payment is called. A store's own report is never "confirmed":
 *  only the provider confirms (the receipt says "reported received by the
 *  store — not confirmed by the provider"). */
export function mmgMovedLabel(paymentStatus: string | null | undefined): string {
  return paymentStatus === 'CAPTURED' ? 'MMG payment received' : 'MMG payment reported received by your store';
}

/** Why a payment cannot be confirmed here, said instead of a button; null when there is nothing to say. */
const BLOCKED: Record<string, string> = {
  REFUNDED: 'This payment was refunded — a new payment is a new transaction.',
  PARTIALLY_REFUNDED: 'This payment was partly refunded — support settles the rest.',
  FAILED: 'MMG reports this payment as failed. Contact support with the reference if money did reach you.',
  EXPIRED: 'The payment window closed — ask the customer to pay again.',
  UNKNOWN: 'This payment is unresolved with MMG. Support settles it; it cannot be marked received here.',
  CANCELLED: 'This payment was superseded.',
};
export function mmgPayBlockedReason(paymentStatus: string | null | undefined): string | null {
  return BLOCKED[String(paymentStatus ?? '')] ?? null;
}
