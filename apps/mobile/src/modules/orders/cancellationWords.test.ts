import { describe, expect, it } from 'vitest';
import { customerCancellationWords, parseCustomerCancellation } from '@swift/types/src/customer-cancellation-words';

// ---------------------------------------------------------------------------
// [owner 8 Nov 2026] The words for a cancelled order, by who closed it (@swift/types order-words.ts): the activity
// row's label, the order screen's sentence, and a money line only where it is certainly true for the payment method.
// ---------------------------------------------------------------------------

const order = (by: string, reason: string | null, extra: Record<string, unknown> = {}) => ({
  status: 'CANCELLED', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', paymentMethod: 'CASH', paymentStatus: 'PENDING',
  cancellation: { by, reason }, ...extra,
});

describe('customerCancellationWords', () => {
  it('the store declined it: label, sentence, and cash was never charged', () => {
    expect(customerCancellationWords(order('STORE', 'Out of stock'))).toEqual({
      label: 'Declined by store · Out of stock',
      headline: 'The store declined your order: Out of stock.',
      money: 'You weren’t charged.',
    });
    // A reason that ends its own sentence is not given a second full stop.
    expect(customerCancellationWords(order('STORE', 'Closing soon!'))?.headline).toBe('The store declined your order: Closing soon!');
    expect(customerCancellationWords(order('STORE', null))).toMatchObject({ label: 'Declined by store', headline: 'The store declined your order.' });
  });

  it('money per payment method: cash never charged; MMG waiting is refunded by the store directly; any other MMG state says nothing', () => {
    expect(customerCancellationWords(order('STORE', 'Out of stock', { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' }))?.money)
      .toBe('If you already sent the MMG payment, the store refunds you directly.');
    for (const paymentStatus of ['CAPTURED', 'CLAIMED', 'REFUNDED', 'UNKNOWN']) {
      expect(customerCancellationWords(order('STORE', 'Out of stock', { paymentMethod: 'MOBILE_MONEY', paymentStatus }))?.money).toBeNull();
    }
    expect(customerCancellationWords(order('STORE', 'Out of stock', { paymentMethod: 'CARD' }))?.money).toBeNull();
    // Cash is only "not charged" while the order still says it is unpaid.
    expect(customerCancellationWords(order('STORE', 'Out of stock', { paymentStatus: 'CAPTURED' }))?.money).toBeNull();
    expect(customerCancellationWords(order('STORE', 'Out of stock', { paymentMethod: undefined }))?.money).toBeNull();
  });

  it('a booking is the provider’s, in booking words', () => {
    expect(customerCancellationWords(order('STORE', 'Fully booked at that time', { fulfillment: 'APPOINTMENT', paymentMethod: 'MOBILE_MONEY' }))).toEqual({
      label: 'Declined by provider · Fully booked at that time',
      headline: 'The provider declined your booking: Fully booked at that time.',
      money: 'If you already sent the MMG payment, the provider refunds you directly.',
    });
    expect(customerCancellationWords(order('NO_RESPONSE', null, { fulfillment: 'APPOINTMENT' }))).toMatchObject({
      label: 'Provider didn’t respond', headline: 'The provider didn’t respond in time, so your booking was cancelled.',
    });
  });

  it('every other party has distinct words', () => {
    expect(customerCancellationWords(order('NO_RESPONSE', null))).toEqual({
      label: 'Store didn’t respond', headline: 'The store didn’t respond in time, so your order was cancelled.', money: 'You weren’t charged.',
    });
    expect(customerCancellationWords(order('CUSTOMER', null))).toEqual({ label: 'Cancelled by you', headline: 'You cancelled this order.', money: 'You weren’t charged.' });
    // Swift support may close an order at any stage: no claim about cash; MMG waiting keeps the store's refund line.
    expect(customerCancellationWords(order('SWIFT', null))).toEqual({ label: 'Cancelled by Swift', headline: 'Swift support cancelled this order.', money: null });
    expect(customerCancellationWords(order('SWIFT', null, { paymentMethod: 'MOBILE_MONEY' }))?.money).toBe('If you already sent the MMG payment, the store refunds you directly.');
    expect(customerCancellationWords(order('NO_SHOW', null, { fulfillment: 'PICKUP' }))).toEqual({
      label: 'Not collected', headline: 'The store recorded that this order wasn’t collected, so it was closed.', money: null,
    });
    expect(customerCancellationWords(order('NO_SHOW', null, { fulfillment: 'APPOINTMENT' }))?.label).toBe('Marked as missed');
    expect(customerCancellationWords(order('SYSTEM', 'FOOD_TOO_OLD'))).toEqual({
      label: 'No rider found',
      headline: 'Your order was ready but no rider could be found, so it was cancelled rather than delivered cold.',
      money: 'You weren’t charged.',
    });
    expect(customerCancellationWords(order('SYSTEM', null))).toMatchObject({ label: 'Cancelled', headline: 'This order was cancelled.' });
    // An unknown code never shows as a code.
    expect(customerCancellationWords(order('SYSTEM', 'SOME_CODE'))?.headline).toBe('This order was cancelled.');
  });

  it('a ride and a parcel: their own nouns, and never a money line (paid to the driver or rider at the end)', () => {
    expect(customerCancellationWords(order('SYSTEM', 'NO_DRIVERS_AVAILABLE', { orderType: 'TAXI' }))).toEqual({
      label: 'No driver found', headline: 'No drivers came online in time, so your request was released. Nothing to pay.', money: null,
    });
    expect(customerCancellationWords(order('NO_SHOW', null, { orderType: 'TAXI' }))).toEqual({
      label: 'Marked as a no-show', headline: 'The driver recorded that you didn’t come to the pickup, so the ride was cancelled.', money: null,
    });
    expect(customerCancellationWords(order('CUSTOMER', null, { orderType: 'TAXI' }))).toEqual({ label: 'Cancelled by you', headline: 'You cancelled this ride.', money: null });
    expect(customerCancellationWords(order('SYSTEM', 'NO_RIDER_FOR_PARCEL', { orderType: 'COURIER' }))).toEqual({
      label: 'No rider found', headline: 'No rider could be found for your parcel in time, so it was cancelled. You can send it again any time.', money: null,
    });
    expect(customerCancellationWords(order('SWIFT', null, { orderType: 'COURIER' }))?.headline).toBe('Swift support cancelled this request.');
  });

  it('null when there is nothing this build can read: not cancelled, no cancellation, an unknown party', () => {
    expect(customerCancellationWords(order('STORE', 'Out of stock', { status: 'DELIVERED' }))).toBeNull();
    expect(customerCancellationWords(order('STORE', 'Out of stock', { status: 'REFUNDED' }))).toBeNull();
    expect(customerCancellationWords({ status: 'CANCELLED' })).toBeNull();
    expect(customerCancellationWords(order('SOMEONE_NEW', 'x'))).toBeNull();
    expect(customerCancellationWords(null)).toBeNull();
    expect(parseCustomerCancellation({ by: 'STORE', reason: '  ' })).toEqual({ by: 'STORE', reason: null });
    expect(parseCustomerCancellation({ by: 'STORE', reason: 7 })).toEqual({ by: 'STORE', reason: null });
    expect(parseCustomerCancellation('STORE')).toBeNull();
  });
});
