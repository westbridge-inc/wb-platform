import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ringMoney } from './ringMoney';

// [RING-FOOD · owner bug 11 Nov 2026] A customer tipped the rider and the store's ringing new-order screen showed a
// "Total" with the tip (and the rider's delivery fee) in it. The big number is the store's money for the goods.
const order = (over: Record<string, unknown> = {}) => ({
  subtotalCustomer: '4000.00', discount: '0.00', deliveryFee: '500.00', tipAmount: '300.00', totalAmount: '4800.00',
  fulfillment: 'DELIVERY', fulfillmentMode: null, paymentMethod: 'CASH',
  vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: false },
  ...over,
});

describe('the ring screen shows the store its own money', () => {
  it('a tipped Swift-rider cash order: the big number is the food, never the tip or the delivery fee', () => {
    const r = ringMoney(order());
    expect(r.food).toBe(4000);
    expect(r.food).not.toBe(4800);
    expect(r.label).toBe('Food');
    expect(r.note).toBe('Delivery fee & tip go to the rider');
  });

  it('an MMG order with a Swift rider: still the food; the fee and tip are the rider’s', () => {
    const r = ringMoney(order({ paymentMethod: 'MOBILE_MONEY' }));
    expect(r.food).toBe(4000);
    expect(r.note).toBe('Delivery fee & tip go to the rider');
  });

  it('the store’s own rider delivers: the fee and tip are the store’s (recorded choice or standing setting)', () => {
    expect(ringMoney(order({ fulfillmentMode: 'VENDOR_DELIVERY' })).note).toBe('Delivery fee & tip are yours — your rider delivers');
    expect(ringMoney(order({ vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: true } })).note).toBe('Delivery fee & tip are yours — your rider delivers');
    // A recorded Swift-rider choice beats the standing setting.
    expect(ringMoney(order({ fulfillmentMode: 'PLATFORM_RIDER', vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: true } })).note).toBe('Delivery fee & tip go to the rider');
    expect(ringMoney(order({ fulfillmentMode: 'VENDOR_DELIVERY' })).food).toBe(4000);
  });

  it('only what the order carries is named', () => {
    expect(ringMoney(order({ tipAmount: '0.00' })).note).toBe('Delivery fee goes to the rider');
    expect(ringMoney(order({ deliveryFee: '0.00' })).note).toBe('Tip goes to the rider');
    expect(ringMoney(order({ deliveryFee: '0.00', tipAmount: '0.00' })).note).toBeNull();
  });

  it('a pickup is the food alone, no rider line', () => {
    const r = ringMoney(order({ fulfillment: 'PICKUP', deliveryFee: '0.00', tipAmount: '0.00', totalAmount: '4000.00' }));
    expect(r.food).toBe(4000);
    expect(r.note).toBeNull();
  });

  it('a discount lowers the food; it never raises it, and never reaches the fee or tip', () => {
    expect(ringMoney(order({ discount: '400.00' })).food).toBe(3600);
    expect(ringMoney(order({ discount: '9000.00' })).food).toBe(0);
  });

  it('names the goods by the store’s kind, and shows no number when none arrived', () => {
    expect(ringMoney(order({ vendor: { vendorType: 'SUPERMARKET' } })).label).toBe('Items');
    expect(ringMoney(order({ vendor: null }), 'RESTAURANT').label).toBe('Food');
    expect(ringMoney(order({ fulfillment: 'APPOINTMENT' })).label).toBe('Service');
    expect(ringMoney(order({ subtotalCustomer: undefined })).food).toBeNull();
    expect(ringMoney(order({ subtotalCustomer: 'garbage' })).food).toBeNull();
  });

  it('the phone’s ring screen shows ringMoney’s number, not the customer’s total', () => {
    const screen = readFileSync(join(process.cwd(), 'src/modules/vendor/NewOrderTakeover.tsx'), 'utf8');
    expect(screen).toContain('const ring = o ? ringMoney(o, storeKind) : null;');
    expect(screen).toContain('<Money amount={ring.food} size="l" />');
    expect(screen).not.toContain('o.totalAmount');
  });
});
