import { tooBusyReason } from './store-kind-words';

/**
 * [E10] The reasons a store gives when it rejects an order. The API requires
 * one on every rejection and tells the customer, so the words must fit the
 * order: a salon declining a booking cannot say its kitchen is busy (DS200 D3).
 * The phone app carries the same lists (apps/mobile/src/modules/vendor/rejectReasons.ts).
 */
export const ORDER_REJECT_REASONS = ['Out of stock', 'Kitchen is too busy', 'Closing soon'] as const;
export const BOOKING_REJECT_REASONS = ['Fully booked at that time', 'Not available that day', 'Closing early that day'] as const;

/**
 * [STORE-WORDS sweep · 9 Nov 2026] A clothing shop rejecting an order told its customer "Kitchen is too busy".
 * The busy reason follows the store's kind (lib store kind words): a restaurant keeps "Kitchen is too busy"
 * exactly (ORDER_REJECT_REASONS); any other store says "Too busy right now".
 */
export function rejectReasonsFor(fulfillment: string | null | undefined, vendorType?: string | null): readonly string[] {
  if (fulfillment === 'APPOINTMENT') return BOOKING_REJECT_REASONS;
  return vendorType === 'RESTAURANT' ? ORDER_REJECT_REASONS : ['Out of stock', tooBusyReason(vendorType), 'Closing soon'];
}
