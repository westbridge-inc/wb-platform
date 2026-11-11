import { describe, expect, it } from 'vitest';
import { canVendorConfirmDelivered, deliveryOwnerView } from './delivery-owner';

describe('vendor delivery owner contract', () => {
  // [PROD-RIDER-TEST 11 Nov 2026 · COORD ruling (a)1] The search for THIS order came back empty: the store is asked
  // "No rider found. Deliver it yourselves?" and may take it with one tap without the standing setting.
  it('[PROD-RIDER-TEST (a)1] no rider found: one tap to deliver it, without the setting, in the server\'s words', () => {
    expect(deliveryOwnerView({
      fulfillment: 'DELIVERY',
      fulfillmentMode: 'PLATFORM_RIDER',
      status: 'READY_FOR_PICKUP',
      selfDeliveryEnabled: false,
      noRiderFound: true,
      noRiderPrompt: 'No rider found. Deliver it yourselves?',
      noRiderDetail: 'Server detail.',
    })).toMatchObject({
      noRider: true,
      title: 'No rider found. Deliver it yourselves?',
      description: 'Server detail.',
      canChooseVendor: true,
      vendorChoiceLabel: 'We’ll deliver it',
    });
  });

  it('[PROD-RIDER-TEST (a)1] no prompt once a rider has it, once the store delivers it, or when the server says nothing', () => {
    const base = { fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', status: 'PREPARING', selfDeliveryEnabled: false } as const;
    expect(deliveryOwnerView({ ...base, noRiderFound: true, riderId: 'r1' })).toMatchObject({ noRider: false, canChooseVendor: false });
    expect(deliveryOwnerView({ ...base, fulfillmentMode: 'VENDOR_DELIVERY', noRiderFound: true })).toMatchObject({ noRider: false, canChooseVendor: false, title: 'Your store delivers this order' });
    expect(deliveryOwnerView({ ...base })).toMatchObject({ noRider: false, canChooseVendor: false, vendorChoiceLabel: 'We’ll deliver' });
  });

  it('offers self-delivery only when enabled and the server has no rider', () => {
    expect(deliveryOwnerView({
      fulfillment: 'DELIVERY',
      fulfillmentMode: 'PLATFORM_RIDER',
      status: 'READY_FOR_PICKUP',
      selfDeliveryEnabled: true,
    })).toMatchObject({
      title: 'Platform rider delivery selected',
      riderAssigned: false,
      canChooseVendor: true,
      canChoosePlatform: false,
    });
  });

  it('keeps the platform-rider escape when global self-delivery was disabled later', () => {
    expect(deliveryOwnerView({
      fulfillment: 'DELIVERY',
      fulfillmentMode: 'VENDOR_DELIVERY',
      status: 'PREPARING',
      selfDeliveryEnabled: false,
    })).toMatchObject({
      title: 'Your store delivers this order',
      canChooseVendor: false,
      canChoosePlatform: true,
    });
  });

  it('uses assignment identity rather than a rider display name', () => {
    expect(deliveryOwnerView({
      fulfillment: 'DELIVERY',
      fulfillmentMode: 'PLATFORM_RIDER',
      status: 'PREPARING',
      riderId: 'rider-without-profile-name',
      selfDeliveryEnabled: true,
    })).toMatchObject({
      title: 'A Swift rider delivers this order',
      riderAssigned: true,
      canChooseVendor: false,
      canChoosePlatform: false,
    });
  });

  it('does not claim a rider search when authority is unresolved', () => {
    expect(deliveryOwnerView({
      fulfillment: 'DELIVERY',
      fulfillmentMode: null,
      status: 'PENDING',
      selfDeliveryEnabled: true,
    })).toMatchObject({
      title: 'Delivery owner not chosen yet',
      description: 'No delivery owner has been recorded yet.',
      canChooseVendor: false,
      canChoosePlatform: false,
    });
  });

  it('does not put pickup or appointments onto the delivery-owner path', () => {
    expect(deliveryOwnerView({ fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP' }).active).toBe(false);
    expect(deliveryOwnerView({ fulfillment: 'APPOINTMENT', status: 'ACCEPTED' }).active).toBe(false);
  });

  it('gives only a riderless, store-owned ready delivery its terminal action', () => {
    const base = { fulfillment: 'DELIVERY', status: 'READY_FOR_PICKUP' };
    expect(canVendorConfirmDelivered({ ...base, fulfillmentMode: 'VENDOR_DELIVERY', riderId: null })).toBe(true);
    expect(canVendorConfirmDelivered({ ...base, fulfillmentMode: 'PLATFORM_RIDER', riderId: null })).toBe(false);
    expect(canVendorConfirmDelivered({ ...base, fulfillmentMode: 'VENDOR_DELIVERY', riderId: 'assigned-rider' })).toBe(false);
  });
});
