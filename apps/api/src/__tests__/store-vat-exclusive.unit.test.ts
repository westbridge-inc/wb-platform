import { describe, it, expect } from 'vitest';
import { orderVat, vatOnTopWhole } from '../modules/store-vat/vat-math';
import { priceBasket, riderCashForLines } from '../modules/order/cart-plans';
import { vatOnTopChange, vatOnTopPlan, orderVatCreateFields } from '../modules/store-vat/order-vat';
import {
  PRICES_EXCLUDE_VAT, storeVatEffective, storeVatModesOffered, storeVatOnTop, type StoreVatRow,
} from '../modules/store-vat/store-vat';
import { riderFloatForOrder } from '../modules/dispatch/float.service';
import { cashMathForOffer } from '../modules/dispatch/dispatch.service';
import { coveredAmountFor } from '../modules/cash/rlp';
import { storeMoney } from '../modules/billing/store-money';
import { renderReceiptHtml } from '../modules/order/receipt';
import { buildVatReport } from '../modules/store-vat/vat-report';
import { storeVatApprovedNotice, storeVatModeChangeApprovedNotice, storeVatWithdrawnNotice } from '../modules/store-vat/store-vat-notices';
import { substitutionView } from '../modules/order/substitution-view';
import { shapeCheckoutAnswer } from '../modules/order/checkout-answer';

// ---------------------------------------------------------------------------
// [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] A VAT-registered store prices BEFORE VAT: the menu shows its prices exactly as
// typed; the cart, checkout and receipt add ONE "VAT 14%" line (the store's VAT on its standard-rated goods, after the
// discount the store itself gives, half-up to the whole dollar, once per order) and then the Total. Every money path
// that reads the order's total reads the same number: the quote, the charge, the rider's cash at pickup and at the door,
// the MMG amount, the store's figure, the receipt, the VAT report, and every picking change.
// ---------------------------------------------------------------------------

const ON = { STORE_VAT: '1', STORE_VAT_EXCLUSIVE: '1' };
const approved = (over: Partial<StoreVatRow> = {}): StoreVatRow => ({
  vatRegistrationNumber: '012345678', vatStatus: 'APPROVED', vatMode: PRICES_EXCLUDE_VAT,
  vatApprovedNumber: '012345678', vatApprovedName: 'Aarna Ltd', vatEffectiveFrom: new Date('2026-01-01T00:00:00Z'), ...over,
});

describe('1. the arithmetic: 14% ON TOP of the standard-rated goods, half-up to the whole dollar, ONCE per order', () => {
  it('vatOnTopWhole: exact, half-up, never a float rounding', () => {
    expect(vatOnTopWhole(100)).toBe(14);
    expect(vatOnTopWhole(1000)).toBe(140);
    expect(vatOnTopWhole(25)).toBe(4); // 3.50 -> half-up
    expect(vatOnTopWhole(75)).toBe(11); // 10.50 -> half-up
    expect(vatOnTopWhole(1234.56)).toBe(173); // 172.8384
    expect(vatOnTopWhole(10.71)).toBe(1); // 1.4994
    expect(vatOnTopWhole(10.72)).toBe(2); // 1.5008
    expect(vatOnTopWhole(0)).toBe(0);
  });

  it('ONE amount per order (25 + 75 = 100 -> 14), never a sum of per-line roundings (4 + 11 = 15)', () => {
    const r = orderVat({ lines: [{ id: 'a', amount: 25, vatClass: 'STANDARD' }, { id: 'b', amount: 75, vatClass: 'STANDARD' }], basis: 'ON_TOP' });
    expect(r.vatAmount).toBe(14);
    expect(r.vatBase).toBe(100);
  });

  it('zero-rated and exempt goods carry no VAT and are reported separately', () => {
    const r = orderVat({
      lines: [{ id: 's', amount: 300, vatClass: 'STANDARD' }, { id: 'z', amount: 600, vatClass: 'ZERO_RATED' }, { id: 'e', amount: 75, vatClass: 'EXEMPT' }],
      basis: 'ON_TOP',
    });
    expect(r).toMatchObject({ vatAmount: 42, standardGoods: 300, zeroRatedGoods: 600, exemptGoods: 75, vatBase: 300, rateBps: 1400 });
  });

  it('the store\'s own goods discount lowers the base (split across the lines as the redemption stores it)', () => {
    const lines = [{ id: 's', amount: 300, vatClass: 'STANDARD' as const }, { id: 'z', amount: 600, vatClass: 'ZERO_RATED' as const }];
    // 90 off 900 -> 30 on the standard line -> base 270 -> 37.8 -> 38
    expect(orderVat({ lines, goodsDiscount: 90, basis: 'ON_TOP' }).vatAmount).toBe(38);
  });

  it('the INCLUDED basis is unchanged (the tax fraction 14/114 of a VAT-inclusive base)', () => {
    expect(orderVat({ lines: [{ id: 'a', amount: 1000, vatClass: 'STANDARD' }] }).vatAmount).toBe(123);
    expect(orderVat({ lines: [{ id: 'a', amount: 1000, vatClass: 'STANDARD' }], basis: 'INCLUDED' }).vatAmount).toBe(123);
  });
});

describe('2. the basket pricer the quote AND checkout use: "VAT 14%" inside every total', () => {
  const lines = [{ amount: 300, vatClass: 'STANDARD' }, { amount: 600, vatClass: 'ZERO_RATED' }];
  const terms = { sellerNumber: '012345678', sellerName: 'Aarna Ltd', rateBps: 1400, onTop: true };
  const plan = (over: Record<string, unknown> = {}) => ({
    vendorId: 'v1', fulfillment: 'DELIVERY' as const, subtotal: 900, deliveryFee: 800, standardDeliveryFee: 800,
    vatOnTop: vatOnTopPlan(terms, lines), ...over,
  });

  it('no promo: total = goods + delivery + tip + VAT; the VAT is the plan\'s `tax`', () => {
    const priced = priceBasket({ plans: [plan()], promo: null, tip: 200 });
    expect(priced.perPlan[0]).toMatchObject({ tax: 42, total: 900 + 800 + 200 + 42, discount: 0 });
    expect(priced.perPlan[0]!.vat).toMatchObject({ vatAmount: 42, vatBase: 300, standardGoods: 300, zeroRatedGoods: 600 });
    expect(priced.grandTotal).toBe(1942);
  });

  it('a store-funded code: the discount comes off the goods BEFORE the VAT, and only its share of the standard goods lowers the VAT', () => {
    const priced = priceBasket({ plans: [plan()], promo: { discountType: 'PERCENTAGE', discountValue: 10, funder: 'VENDOR', vendorId: 'v1' }, tip: 0 });
    expect(priced.perPlan[0]).toMatchObject({ discount: 90, tax: 38, total: 900 - 90 + 800 + 38 });
    expect(priced.grandTotal).toBe(priced.perPlan[0]!.total);
  });

  it('a Swift-funded code never lowers the store\'s VAT (it is paid to the store): VAT on the full goods', () => {
    const priced = priceBasket({ plans: [plan()], promo: { discountType: 'FIXED_AMOUNT', discountValue: 100, funder: 'PLATFORM' }, tip: 0 });
    expect(priced.perPlan[0]).toMatchObject({ discount: 100, tax: 42, total: 900 - 100 + 800 + 42 });
  });

  it('delivery pay and tips never carry the store\'s VAT; a store with no VAT on top adds nothing', () => {
    const noVat = priceBasket({ plans: [plan({ vatOnTop: null })], promo: null, tip: 500 });
    expect(noVat.perPlan[0]).toMatchObject({ tax: 0, vat: null, total: 900 + 800 + 500 });
    // A store whose prices INCLUDE VAT is never priced on top.
    expect(vatOnTopPlan({ ...terms, onTop: false }, lines)).toBeNull();
    expect(vatOnTopPlan(null, lines)).toBeNull();
  });

  it('a two-store basket: each store\'s VAT on its own plan, and the grand total is their sum', () => {
    const priced = priceBasket({ plans: [plan(), plan({ vendorId: 'v2', vatOnTop: null, subtotal: 500 })], promo: null, tip: 0 });
    expect(priced.perPlan.map((p) => p.tax)).toEqual([42, 0]);
    expect(priced.grandTotal).toBe(priced.perPlan.reduce((s, p) => s + p.total, 0));
  });

  it('the rider fronts the goods AND their VAT on a cash basket (the probe and the banner)', () => {
    const cartLines = [
      { quantity: 3, selectedOptions: null, item: { basePrice: 100, optionGroups: [], vatClass: 'STANDARD' } },
      { quantity: 1, selectedOptions: null, item: { basePrice: 600, optionGroups: [], vatClass: 'ZERO_RATED' } },
    ];
    expect(riderCashForLines(cartLines)).toBe(900);
    expect(riderCashForLines(cartLines, { rateBps: 1400 })).toBe(942);
  });

  it('a placed order freezes the basis with the rate (vatOnTop only on a store pricing before VAT)', () => {
    expect(orderVatCreateFields(terms)).toEqual({ vatRateBps: 1400, vatSellerNumber: '012345678', vatSellerName: 'Aarna Ltd', vatOnTop: true });
    expect(orderVatCreateFields({ ...terms, onTop: false })).toEqual({ vatRateBps: 1400, vatSellerNumber: '012345678', vatSellerName: 'Aarna Ltd' });
    expect(orderVatCreateFields(null)).toEqual({});
  });
});

describe('3. the predicate and the switches: deployed dark, and a switch flip never changes what a customer pays', () => {
  it('prices before VAT is offered only while STORE_VAT_EXCLUSIVE is exactly 1, and listed first', () => {
    expect(storeVatModesOffered({ STORE_VAT: '1' })).toEqual(['PRICES_INCLUDE_VAT', 'ADD_VAT_AT_CHECKOUT']);
    expect(storeVatModesOffered(ON)).toEqual(['PRICES_EXCLUDE_VAT', 'PRICES_INCLUDE_VAT']);
  });

  it('an approved store pricing before VAT adds its VAT while the approval stands, whatever the switches', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    expect(storeVatOnTop(approved(), ON, now)).toBe(true);
    expect(storeVatOnTop(approved(), { STORE_VAT: '1' }, now)).toBe(true);
    expect(storeVatOnTop(approved(), {}, now)).toBe(true);
    // Not approved, or the number changed since: no VAT (a person must look again).
    expect(storeVatOnTop(approved({ vatStatus: 'PENDING' }), ON, now)).toBe(false);
    expect(storeVatOnTop(approved({ vatRegistrationNumber: '099999999' }), ON, now)).toBe(false);
    // A store whose prices include VAT keeps STORE_VAT's meaning exactly: off = no VAT shown.
    expect(storeVatEffective(approved({ vatMode: 'PRICES_INCLUDE_VAT' }), {}, now)).toBe(false);
    expect(storeVatOnTop(approved({ vatMode: 'PRICES_INCLUDE_VAT' }), ON, now)).toBe(false);
    expect(storeVatEffective(approved({ vatMode: 'ADD_VAT_AT_CHECKOUT' }), { STORE_VAT: '1' }, now)).toBe(true);
  });
});

describe('4. the rider\'s cash: what the store is paid at pickup and what the door collects', () => {
  const order = {
    orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH', totalAmount: 1942, subtotalBase: 900, taxAmount: 42,
    deliveryFee: 800, serviceFee: 0, tipAmount: 200, discount: 0,
  };
  it('the rider fronts the goods AND their VAT; the card reconciles: collect the total, pay the store goods + VAT, keep fee + tip', () => {
    expect(riderFloatForOrder(order)).toBe(942);
    expect(cashMathForOffer(order)).toEqual({ collectFromCustomer: 1942, payToVendor: 942, youKeep: 1000 });
    // A total that does not add up is refused, never shown.
    expect(cashMathForOffer({ ...order, totalAmount: 1900 })).toBeNull();
    // The rider's loss cover is what was fronted.
    expect(coveredAmountFor(order)).toBe(942);
  });
  it('every other order is unchanged (taxAmount 0)', () => {
    const plain = { ...order, taxAmount: 0, totalAmount: 1900 };
    expect(riderFloatForOrder(plain)).toBe(900);
    expect(cashMathForOffer(plain)).toEqual({ collectFromCustomer: 1900, payToVendor: 900, youKeep: 1000 });
  });
});

describe('5. the store\'s figure: its food money includes the VAT it collects for the GRA', () => {
  const base = {
    orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', fulfillmentMode: null, paymentMethod: 'CASH', currencyCode: 'GYD',
    subtotalCustomer: '900.00', discount: '0.00', deliveryFee: '800.00', tipAmount: '200.00', totalAmount: '1942.00', taxAmount: '42.00', vatRateBps: 1400,
    promoRedemption: null, vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: false },
  };
  it('cash + Swift rider: the store receives goods + VAT, and a line names the VAT', () => {
    const m = storeMoney(base)!;
    expect(m.food).toBe(942);
    expect(m.addedTax).toBe(42);
    expect(m.lines[0]).toBe('Includes VAT 14% added at checkout: $42 (yours, for the GRA)');
    expect(m.riderFeeAndTip).toBe(1000);
  });
  it('MMG + Swift rider: the customer pays the store the whole total, VAT inside', () => {
    const m = storeMoney({ ...base, paymentMethod: 'MOBILE_MONEY' })!;
    expect(m.customerPaysYou).toBe(1942);
    expect(m.food).toBe(942);
  });
  it('an order without VAT on top is unchanged', () => {
    const m = storeMoney({ ...base, taxAmount: '0.00', vatRateBps: null, totalAmount: '1900.00' })!;
    expect(m.food).toBe(900);
    expect(m.addedTax).toBe(0);
    expect(m.lines.some((l) => l.includes('VAT'))).toBe(false);
  });
});

describe('6. the receipt: "VAT 14%" then "Total", like the store\'s own bill; never a tax invoice', () => {
  const order = {
    orderNumber: 'SW-20261113-0001', placedAt: new Date('2026-11-13T14:00:00Z'), status: 'DELIVERED', orderType: 'FOOD_DELIVERY',
    fulfillment: 'DELIVERY', paymentMethod: 'CASH', paymentStatus: 'CAPTURED', subtotalCustomer: 900, deliveryFee: 800, tipAmount: 200,
    discount: 0, totalAmount: 1942, taxAmount: 42, deliveryAddress: '1 Main St', currencyCode: 'GYD',
    vendor: { name: 'Aarna', addressLine1: '2 Shop St', city: 'Georgetown', phone: '+5926000000' }, seller: null,
    customer: { firstName: 'Ann', lastName: 'B' },
    items: [{ name: 'Curry', quantity: 3, totalCustomer: 300, vatClass: 'STANDARD' }, { name: 'Rice', quantity: 1, totalCustomer: 600, vatClass: 'ZERO_RATED' }],
    vatRateBps: 1400, vatAmount: 42, vatStandardGoods: 300, vatZeroRatedGoods: 600, vatExemptGoods: 0, vatBase: 300,
    vatSellerNumber: '012345678', vatSellerName: 'Aarna Ltd', vatOnTop: true,
  };
  it('the VAT row sits right above the Total, after the items, delivery and tip', () => {
    const html = renderReceiptHtml(order as never);
    const at = (s: string) => html.indexOf(s);
    expect(html).toContain('<tr class="totals"><td>VAT 14%</td><td class="num">GY$42 GYD</td></tr>\n    <tr class="grand"><td>Total</td><td class="num">GY$1,942 GYD</td></tr>');
    expect(at('<td>VAT 14%</td>')).toBeGreaterThan(at('Rider tip'));
    expect(at('<td>VAT 14%</td>')).toBeGreaterThan(at('<td>Items</td>'));
    expect(html).toContain('Standard-rated goods (before VAT)');
    expect(html).toContain('VAT added (14%)');
    expect(html).toContain('The prices of the goods exclude VAT; VAT at 14% is added');
    expect(html).not.toMatch(/tax invoice<|Tax invoice|TAX INVOICE/);
    expect(html).toContain('Aarna Ltd issues its own tax invoice for these goods.');
    expect(html).not.toContain('VAT included (14%)');
  });
  it('a VAT-inclusive order keeps its summary and has no VAT row in the totals', () => {
    const html = renderReceiptHtml({ ...order, vatOnTop: false, taxAmount: 0, totalAmount: 1900 } as never);
    expect(html).not.toContain('<td>VAT 14%</td>');
    expect(html).toContain('VAT included (14%)');
  });
});

describe('7. the VAT report reads each order on its own basis', () => {
  it('an order with VAT on top: line 17 is the base itself; an order with VAT inside: base less VAT', () => {
    const r = buildVatReport([
      { id: 'a', orderNumber: 'SW-1', vatRateBps: 1400, vatBase: 300, vatAmount: 42, vatZeroRatedGoods: 600, vatExemptGoods: 0, vatSellerName: 'A', vatSellerNumber: '1', vatOnTop: true, supplyDay: '2026-11-13' },
      { id: 'b', orderNumber: 'SW-2', vatRateBps: 1400, vatBase: 1140, vatAmount: 140, vatZeroRatedGoods: 0, vatExemptGoods: 0, vatSellerName: 'A', vatSellerNumber: '1', supplyDay: '2026-11-13' },
    ], '2026-11-01', '2026-11-30');
    expect(r.orders[0]).toMatchObject({ standardRatedExclVat: 300, standardRatedInclVat: 342, vatCharged: 42 });
    expect(r.orders[1]).toMatchObject({ standardRatedExclVat: 1000, standardRatedInclVat: 1140, vatCharged: 140 });
    expect(r.returnLines.find((l) => l.line === 17)?.amount).toBe(1300);
    expect(r.returnLines.find((l) => l.line === 18)?.amount).toBe(182);
  });
});

describe('8. picking: a change to the goods moves the VAT line and the total by the same rule recompute applies', () => {
  const order = {
    vatRateBps: 1400, vatOnTop: true, vatAmount: 42, discount: 0, promoRedemption: null,
    items: [
      { id: 'a', subStatus: 'NONE', totalCustomer: 300, vatClass: 'STANDARD' },
      { id: 'b', subStatus: 'NONE', totalCustomer: 600, vatClass: 'ZERO_RATED' },
    ],
  };
  it('a standard line off: its VAT comes off too', () => {
    expect(vatOnTopChange(order, { lineId: 'a', newLineTotal: 0 })).toBe(-42);
    expect(vatOnTopChange(order, { lineId: 'b', newLineTotal: 0 })).toBe(0);
  });
  it('a same-price swap of a zero-rated line for a standard-rated item ADDS VAT (the total moves)', () => {
    expect(vatOnTopChange(order, { lineId: 'b', newLineTotal: 600, vatClass: 'STANDARD' })).toBe(84);
  });
  it('an order whose VAT is inside its goods (or none) never moves its total for VAT', () => {
    expect(vatOnTopChange({ ...order, vatOnTop: false }, { lineId: 'a', newLineTotal: 0 })).toBe(0);
    expect(vatOnTopChange({ ...order, vatRateBps: null }, { lineId: 'a', newLineTotal: 0 })).toBe(0);
  });
  it('with a store-funded code the discount that goes with the line leaves first, then the VAT is taken on what stays', () => {
    const withCode = {
      ...order, discount: 90, vatAmount: 38,
      promoRedemption: { funder: 'VENDOR', goodsDiscount: 90, lineAllocations: [{ orderItemId: 'a', goods: 30 }, { orderItemId: 'b', goods: 60 }], discountType: 'PERCENTAGE', discountValue: 10, maxDiscount: null },
    };
    // Rice off: the 10% code re-prices on 300 -> 30 left on the soap -> base 270 -> VAT 38: no change.
    expect(vatOnTopChange(withCode, { lineId: 'b', newLineTotal: 0 })).toBe(0);
    // Soap off: nothing standard-rated left -> VAT 0.
    expect(vatOnTopChange(withCode, { lineId: 'a', newLineTotal: 0 })).toBe(-38);
  });

  it('the customer\'s swap card says the change the yes charges, VAT included; MMG only when nothing moves', () => {
    const viewOrder = {
      paymentMethod: 'CASH', status: 'PREPARING', paymentStatus: 'PENDING', acceptedAt: new Date(), mmgAttestedRef: null,
      customerMmgClaim: 'UNRECORDED', mmgPayUrlSnapshot: null, mmgClaimMismatchAt: null, totalAmount: 1942, discount: 0,
      items: order.items, promoRedemption: null, vatOnTop: true, vatRateBps: 1400, vatAmount: 42,
    };
    const swap = {
      id: 'b', subStatus: 'PENDING', name: 'Rice', quantity: 1, totalCustomer: 600, substituteItemId: 'x', substituteName: 'Curry',
      substitutePrice: 600, selectedOptions: [], substituteVatClass: 'STANDARD',
    };
    expect(substitutionView(swap, viewOrder as never)!.priceDelta).toBe(84);
    const removal = { ...swap, id: 'a', totalCustomer: 300, substituteItemId: null, substituteName: null, substitutePrice: null };
    expect(substitutionView(removal, { ...viewOrder, status: 'PENDING', acceptedAt: null } as never)!.priceDelta).toBe(-342);
  });
});

describe('9. the store\'s words name the basis', () => {
  it('approval, a change to prices before VAT, and a withdrawal', () => {
    const approvedWords = storeVatApprovedNotice({ registeredName: 'Aarna Ltd', number: '012345678', effectiveFrom: new Date('2026-01-01T00:00:00Z'), mode: PRICES_EXCLUDE_VAT }).body;
    expect(approvedWords).toContain('customers see the prices you type (before VAT), and VAT at 14% on your standard-rated items is added at checkout as its own line before the total');
    expect(approvedWords).toContain('mark your zero-rated and exempt items now');
    expect(storeVatModeChangeApprovedNotice(PRICES_EXCLUDE_VAT).body).toContain('is added at checkout as its own line before the total');
    const withdrawn = storeVatWithdrawnNotice('GRA cancelled the registration', PRICES_EXCLUDE_VAT).body;
    expect(withdrawn).toContain('VAT is no longer added at checkout, so customers pay the prices you typed.');
    expect(withdrawn).not.toContain('incl. VAT');
  });
});

describe('10. the checkout answer carries the VAT line only when there is one', () => {
  const row = {
    id: 'o1', orderNumber: 'SW-1', status: 'PENDING', vendorId: 'v', subtotalCustomer: 900, deliveryFee: 800, tipAmount: 0,
    discount: 0, totalAmount: 1742, paymentMethod: 'CASH', deliveryAddress: null, placedAt: '2026-11-13T12:00:00.000Z',
  };
  it('tax beside the total on an order with VAT on top; absent on every other answer', () => {
    const withVat = shapeCheckoutAnswer({ orders: [{ ...row, taxAmount: 42, totalAmount: 1784 }] as never, paymentAction: null, grandTotal: 1784 });
    expect(withVat.orders[0]).toMatchObject({ tax: 42, total: 1784 });
    const plain = shapeCheckoutAnswer({ orders: [{ ...row, taxAmount: '0.00' }] as never, paymentAction: null, grandTotal: 1742 });
    expect(plain.orders[0]).not.toHaveProperty('tax');
  });
});

describe('11. a return gives back the VAT added on the returned goods', () => {
  it('a whole-order return of a store pricing before VAT: the goods AND their "VAT 14%" line; nothing changes for any other order', async () => {
    const { computeRefund } = await import('../utils/refund');
    const base = {
      paymentMethod: 'CASH', status: 'DELIVERED', deliveryFee: 800, discount: 0, totalAmount: 1742, deliveryHappened: true,
      lines: [{ id: 'a', totalCustomer: 300, affected: true }, { id: 'b', totalCustomer: 600, affected: true }], currencyCode: 'GYD',
    };
    const withVat = computeRefund({ ...base, addedVat: 42 });
    expect(withVat.amount).toBe(942);
    expect(withVat.sentence).toContain('plus the GY$42 VAT added on them at checkout');
    const plain = computeRefund(base);
    expect(plain.amount).toBe(900);
    expect(plain.sentence).not.toContain('VAT');
  });
});

// ---------------------------------------------------------------------------
// [REVIEW-A / REVIEW-B follow-ups · 13 Nov 2026] The fixer round: each case below was RED on head 16102f34.
// ---------------------------------------------------------------------------

describe('12. [REVIEW-A F4 · REVIEW-B S4-2] the store discount is split in ONE line order on both sides', () => {
  const terms = { sellerNumber: '012345678', sellerName: 'Aarna Ltd', rateBps: 1400, onTop: true };
  const storeCode = { discountType: 'FIXED_AMOUNT' as const, discountValue: 107, funder: 'VENDOR' as const, vendorId: 'v1' };
  const taxFor = (lines: Array<{ amount: number; vatClass: string }>) => priceBasket({
    plans: [{ vendorId: 'v1', fulfillment: 'PICKUP', subtotal: 2000, deliveryFee: 0, standardDeliveryFee: 0, vatOnTop: vatOnTopPlan(terms, lines) }],
    promo: storeCode, tip: 0,
  }).perPlan[0]!.tax;

  it('the 132-vs-133 repro: two lines of 1,000 (standard, zero-rated), a store discount of 107: the same VAT whichever line comes first', () => {
    const stdFirst = taxFor([{ amount: 1000, vatClass: 'STANDARD' }, { amount: 1000, vatClass: 'ZERO_RATED' }]);
    const zeroFirst = taxFor([{ amount: 1000, vatClass: 'ZERO_RATED' }, { amount: 1000, vatClass: 'STANDARD' }]);
    expect(stdFirst).toBe(132); // 1,000 - 54 = 946 -> 132.44 -> 132
    expect(zeroFirst).toBe(stdFirst);
  });

  it('checkout\'s stored shares, split in that order from the placed lines (in either order), recompute the VAT the quote showed', async () => {
    const { inVatSplitOrder } = await import('../modules/store-vat/order-vat');
    const { allocateAcrossLines } = await import('../utils/order-total');
    const quoted = taxFor([{ amount: 1000, vatClass: 'ZERO_RATED' }, { amount: 1000, vatClass: 'STANDARD' }]);
    for (const placed of [
      [{ id: 'std', totalCustomer: 1000, vatClass: 'STANDARD' }, { id: 'zero', totalCustomer: 1000, vatClass: 'ZERO_RATED' }],
      [{ id: 'zero', totalCustomer: 1000, vatClass: 'ZERO_RATED' }, { id: 'std', totalCustomer: 1000, vatClass: 'STANDARD' }],
    ]) {
      const shares = allocateAcrossLines(107, inVatSplitOrder(placed, (l) => l.vatClass).map((l) => ({ id: l.id, amount: l.totalCustomer })));
      const recomputed = orderVat({
        lines: placed.map((l) => ({ id: l.id, amount: l.totalCustomer, vatClass: l.vatClass as 'STANDARD' | 'ZERO_RATED' })),
        lineGoodsDiscounts: new Map(shares.map((s) => [s.id, s.share] as const)),
        rateBps: 1400, basis: 'ON_TOP',
      });
      expect(recomputed.vatAmount).toBe(quoted);
    }
  });

  it('the order is standard, zero-rated, exempt, each kept in its own order', async () => {
    const { inVatSplitOrder } = await import('../modules/store-vat/order-vat');
    const lines = [{ id: 'e', c: 'EXEMPT' }, { id: 'z1', c: 'ZERO_RATED' }, { id: 's1', c: 'STANDARD' }, { id: 'z2', c: 'ZERO_RATED' }, { id: 's2', c: null }];
    expect(inVatSplitOrder(lines, (l) => l.c).map((l) => l.id)).toEqual(['s1', 's2', 'z1', 'z2', 'e']);
  });
});

describe('13. [REVIEW-A F6] a return\'s dual "inferred" figure counts the VAT added on top too', () => {
  it('the two calculations agree on an on-top return (no false inference difference)', async () => {
    const { computeRefund } = await import('../utils/refund');
    const r = computeRefund({
      paymentMethod: 'CASH', status: 'DELIVERED', deliveryFee: 800, discount: 0, totalAmount: 1742, deliveryHappened: true,
      lines: [{ id: 'a', totalCustomer: 300, affected: true }, { id: 'b', totalCustomer: 600, affected: true }], currencyCode: 'GYD', addedVat: 42,
    });
    expect(r.amount).toBe(942);
    expect(r.inferredAmount).toBe(942);
  });
});

describe('14. [REVIEW-A F2 · REVIEW-B S3-3] the rollback keeps the VAT basis of every order and refuses while it is not safe', () => {
  const dir = async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const base = join(__dirname, '../../prisma/migrations/20261113210000_store_vat_exclusive');
    return { sql: readFileSync(join(base, 'rollback.sql'), 'utf8'), readme: readFileSync(join(base, 'README.md'), 'utf8') };
  };

  it('drops nothing: orders."vatOnTop" (each order\'s basis) and the substitute class stay', async () => {
    const { sql } = await dir();
    expect(sql).not.toMatch(/^\s*(ALTER|DROP)\b/im);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
  });

  it('refuses while an on-top order is open (its open list is exactly the live statuses) or a before-VAT store is still open', async () => {
    const { sql } = await dir();
    const { TERMINAL_ORDER_STATUSES } = await import('../modules/order/order-status');
    const guard = sql.match(/"vatOnTop" = true\s+AND "status" NOT IN \(([^)]*)\)/);
    expect(guard, 'the open-order guard').not.toBeNull();
    expect(guard![1]!.split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual([...TERMINAL_ORDER_STATUSES].sort());
    expect(sql).toMatch(/IF EXISTS \(\s*SELECT 1 FROM "orders"[\s\S]*?\) THEN\s+RAISE EXCEPTION/);
    expect(sql).toMatch(/"vatMode" = 'PRICES_EXCLUDE_VAT' AND "vatStatus" = 'APPROVED' AND "isCurrentlyOpen" = true AND "acceptingOrders" = true[\s\S]*?RAISE EXCEPTION/);
    // Row security off for the transaction BEFORE it looks (a non-bypass role gets an error, never "no rows").
    const begin = sql.indexOf('BEGIN;');
    const off = sql.indexOf('SET LOCAL row_security = off;');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(off).toBeGreaterThan(begin);
    expect(off).toBeLessThan(sql.indexOf('IF EXISTS'));
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('the README is the runbook: close the stores, let their orders finish, run it with the new code live, then roll the code back', async () => {
    const { readme, sql } = await dir();
    const steps = ['**Close**', '**Let their orders finish.**', '**Run `rollback.sql`**', '**Roll the code back.**'].map((s) => readme.indexOf(s));
    expect(steps.every((i) => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(sql).toContain('RUN THIS WHILE THE NEW CODE IS STILL SERVING');
    expect(readme).toContain('Nothing is dropped');
  });
});

describe('15. [REVIEW-A F3 · REVIEW-B S3-1] an app that cannot show the VAT line never orders from a store pricing before VAT', () => {
  it('the capability, and the refusal an older app shows as it is (409 APP_UPDATE_REQUIRED, plain words)', async () => {
    const { VAT_LINE_CAPABILITY, declaresVatLine, vatLineAppUpdateRequired } = await import('../modules/store-vat/vat-line-capability');
    expect(VAT_LINE_CAPABILITY).toBe('VAT_LINE_V1');
    expect(declaresVatLine(['MENU_OPTIONS_V2', 'VAT_LINE_V1'])).toBe(true);
    expect(declaresVatLine(['MENU_OPTIONS_V2'])).toBe(false);
    expect(declaresVatLine(undefined)).toBe(false);
    const err = vatLineAppUpdateRequired(['v1']);
    expect(err).toMatchObject({ statusCode: 409, code: 'APP_UPDATE_REQUIRED' });
    expect(err.message).toBe('This store’s prices are before VAT: VAT is added at checkout as its own line, and this version of the Swift app cannot show it. Update the Swift app to order from this store.');
  });

  it('"+ VAT" is said per item on every list outside the store: search (index, database, trending), the market, Home\'s dishes, the cart lines', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
    expect(src('modules/search/search.routes.ts').match(/withVatAddedHint\(app\.prisma/g)).toHaveLength(3);
    expect(src('modules/market/market.routes.ts').match(/withVatAddedHint\(app\.prisma/g)).toHaveLength(1);
    expect(src('modules/user/customer.routes.ts')).toMatch(/popularItems: await withVatAddedHint\(app\.prisma/);
    expect(src('modules/user/customer.routes.ts')).toMatch(/items: itemDetails\.map\(\(d, i\) => \(\{ \.\.\.d, vatAddedAtCheckout: vatAddedAtCheckout\(/);
    const { vatAddedAtCheckout } = await import('../modules/store-vat/vat-added-hint');
    expect(vatAddedAtCheckout(true, 'STANDARD')).toBe(true);
    expect(vatAddedAtCheckout(true, null)).toBe(true);
    expect(vatAddedAtCheckout(true, 'ZERO_RATED')).toBe(false);
    expect(vatAddedAtCheckout(true, 'EXEMPT')).toBe(false);
    expect(vatAddedAtCheckout(false, 'STANDARD')).toBe(false);
  });
});
