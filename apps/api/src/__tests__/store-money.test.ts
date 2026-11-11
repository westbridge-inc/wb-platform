import { describe, it, expect } from 'vitest';
import { storeMoney, type StoreMoneyOrder } from '../modules/billing/store-money';
import { orderComponents } from '../modules/billing/sales-components';

// ---------------------------------------------------------------------------
// [STORE-MONEY · owner bug 11 Nov 2026] A customer tipped the rider, and the store's ringing new-order screen showed
// a total with the tip (and the rider's delivery fee) in it. What a store sees as its money is computed once, on the
// server, by the sales statement's own law (orderComponents): the food is the store's, the fee and tip are the
// rider's — unless the store's own rider delivers.
// ---------------------------------------------------------------------------

const order = (over: Partial<StoreMoneyOrder> = {}): StoreMoneyOrder => ({
  orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', fulfillmentMode: null, paymentMethod: 'CASH', currencyCode: 'GYD',
  subtotalCustomer: '4000.00', discount: '0.00', deliveryFee: '500.00', tipAmount: '300.00', totalAmount: '4800.00',
  promoRedemption: null, vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: false },
  ...over,
});

describe('[STORE-MONEY] the store sees its own money', () => {
  it('Swift rider + cash: the tip and the delivery fee are not in the store\'s figure', () => {
    const m = storeMoney(order())!;
    expect(m.food).toBe(4000);
    expect(m.food).not.toBe(4800);
    expect(m.foodLabel).toBe('Food — you receive');
    expect(m.delivery).toBe('SWIFT_RIDER');
    expect(m.riderFeeAndTip).toBe(800);
    expect(m.yoursFeeAndTip).toBe(0);
    expect(m.customerPaysYou).toBeNull();
    expect(m.lines).toEqual(["Rider's delivery fee & tip: $800 (not yours)"]);
  });

  it('Swift rider + MMG: the customer pays the store the whole total; the rider\'s part is shown, owed at pickup', () => {
    const m = storeMoney(order({ paymentMethod: 'MOBILE_MONEY' }))!;
    expect(m.food).toBe(4000);
    expect(m.customerPaysYou).toBe(4800);
    expect(m.riderFeeAndTip).toBe(800); // the delivery-cash-settlement amount (fee + tip)
    expect(m.lines).toEqual(["Customer pays you $4,800 by MMG — $800 of it is the rider's, pay it at pickup"]);
    // The arithmetic closes: what lands minus what is passed on is the food.
    expect(m.customerPaysYou! - m.riderFeeAndTip + m.swiftPaysYou).toBe(m.food);
  });

  it('own delivery (recorded choice, or the store\'s standing setting): the fee and tip are the store\'s', () => {
    for (const o of [order({ fulfillmentMode: 'VENDOR_DELIVERY' }), order({ vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: true } })]) {
      const m = storeMoney(o)!;
      expect(m.food).toBe(4000);
      expect(m.delivery).toBe('STORE_RIDER');
      expect(m.yoursFeeAndTip).toBe(800);
      expect(m.riderFeeAndTip).toBe(0);
      expect(m.lines).toEqual(['Delivery fee & tip: $800 (yours — your rider delivers)']);
    }
    // A recorded Swift-rider choice wins over the standing setting.
    expect(storeMoney(order({ fulfillmentMode: 'PLATFORM_RIDER', vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: true } }))!.delivery).toBe('SWIFT_RIDER');
  });

  it('own delivery with a Swift-funded delivery discount: the store keeps the fee less that discount, plus the tip', () => {
    const m = storeMoney(order({
      fulfillmentMode: 'VENDOR_DELIVERY', discount: '500.00', totalAmount: '4300.00',
      promoRedemption: { goodsDiscount: 0, deliveryDiscount: 500, funder: 'PLATFORM' },
    }))!;
    expect(m.food).toBe(4000);
    expect(m.yoursFeeAndTip).toBe(300);
    expect(m.lines).toEqual(['Delivery fee & tip: $300 (yours — your rider delivers)']);
  });

  it('pickup: the food only, no rider line', () => {
    const m = storeMoney(order({ fulfillment: 'PICKUP', deliveryFee: 0, tipAmount: 0, totalAmount: 4000 }))!;
    expect(m).toMatchObject({ food: 4000, delivery: 'PICKUP', riderFeeAndTip: 0, yoursFeeAndTip: 0, customerPaysYou: null, lines: [] });
  });

  it('a store-funded discount lowers the food; a Swift-funded one does not — Swift pays the store that part', () => {
    const own = storeMoney(order({ discount: 400, totalAmount: 4400, promoRedemption: { goodsDiscount: 400, deliveryDiscount: 0, funder: 'VENDOR' } }))!;
    expect(own.food).toBe(3600);
    expect(own.swiftPaysYou).toBe(0);

    const swift = storeMoney(order({ discount: 400, totalAmount: 4400, promoRedemption: { goodsDiscount: 400, deliveryDiscount: 0, funder: 'PLATFORM' } }))!;
    expect(swift.food).toBe(4000);
    expect(swift.swiftPaysYou).toBe(400);
    expect(swift.lines).toContain('Swift pays you $400 (a Swift discount the customer got)');
    // The sales statement's own law, never a second reading of it.
    const c = orderComponents(order({ discount: 400, promoRedemption: { goodsDiscount: 400, deliveryDiscount: 0, funder: 'PLATFORM' } }));
    expect(swift.food).toBe(c.goodsSales - c.vendorPromoDiscount);
    expect(swift.swiftPaysYou).toBe(c.sponsorReceivable);
  });

  it('MMG with a Swift-funded delivery discount: the store passes the rider the full fee + tip, so Swift pays the gap', () => {
    const m = storeMoney(order({
      paymentMethod: 'MOBILE_MONEY', discount: 500, totalAmount: 4300,
      promoRedemption: { goodsDiscount: 0, deliveryDiscount: 500, funder: 'PLATFORM' },
    }))!;
    expect(m.customerPaysYou).toBe(4300);
    expect(m.riderFeeAndTip).toBe(800);
    expect(m.swiftPaysYou).toBe(500);
    expect(m.customerPaysYou! - m.riderFeeAndTip + m.swiftPaysYou).toBe(m.food);
  });

  it('names only what the order carries, and the goods by the store\'s kind', () => {
    expect(storeMoney(order({ tipAmount: 0, totalAmount: 4500 }))!.lines).toEqual(["Rider's delivery fee: $500 (not yours)"]);
    expect(storeMoney(order({ deliveryFee: 0, totalAmount: 4300 }))!.lines).toEqual(["Rider's tip: $300 (not yours)"]);
    expect(storeMoney(order({ vendor: { vendorType: 'SUPERMARKET', selfDeliveryEnabled: false } }))!.foodWord).toBe('Items');
    expect(storeMoney(order({ fulfillment: 'APPOINTMENT', deliveryFee: 0, tipAmount: 0 }))!.foodWord).toBe('Service');
  });

  it('a parcel or a ride is not a store\'s order', () => {
    expect(storeMoney(order({ orderType: 'COURIER' }))).toBeNull();
    expect(storeMoney(order({ orderType: 'TAXI' }))).toBeNull();
  });
});
