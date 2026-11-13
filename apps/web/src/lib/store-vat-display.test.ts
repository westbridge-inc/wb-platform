import { describe, expect, it } from 'vitest';
import { cartVatAddedRows, itemVatAddedHint, orderVatAddedRow, ratePercentWords, storefrontVatAddedNote } from './store-vat-display';
import { orderMoneyNotes, orderMoneyRows } from './vendor-order-view';
import { vatModeChoices, vatModeHelp, vatModeLabel } from './store-vat-words';
import { beforeVatAtCheckoutHint } from './vat-price-edit';
import type { VendorOrder } from './vendor-api';

// [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] The website's words for a store pricing BEFORE VAT: the same as the phone's,
// every amount the server's.

describe('the store page', () => {
  const added = { pricesIncludeVat: false, addedAtCheckout: true, ratePercent: 14 };
  it('says prices exclude VAT and VAT 14% is added at checkout; nothing for any other store', () => {
    expect(storefrontVatAddedNote(added)).toBe('Prices exclude VAT; VAT 14% is added at checkout. Zero-rated and exempt items carry none.');
    expect(storefrontVatAddedNote({ pricesIncludeVat: true, ratePercent: 14 })).toBeNull();
    expect(storefrontVatAddedNote(null)).toBeNull();
  });
  it('"+ VAT" beside a standard-rated price only', () => {
    expect(itemVatAddedHint(added, { vatClass: 'STANDARD' })).toBe('+ VAT');
    expect(itemVatAddedHint(added, {})).toBe('+ VAT');
    expect(itemVatAddedHint(added, { vatClass: 'EXEMPT' })).toBeNull();
    expect(itemVatAddedHint({ pricesIncludeVat: true, ratePercent: 14 }, { vatClass: 'STANDARD' })).toBeNull();
  });
});

describe('checkout and the order: "VAT 14%" above the Total', () => {
  it('one row per store pricing before VAT, named when there are several; none for an older server', () => {
    expect(cartVatAddedRows([{ vendorId: 'v1', name: 'Aarna', vat: { added: 42, ratePercent: 14 } }])).toEqual([{ vendorId: 'v1', label: 'VAT 14%', amount: 42 }]);
    expect(cartVatAddedRows([
      { vendorId: 'v1', name: 'Aarna', vat: { added: 42, ratePercent: 14 } },
      { vendorId: 'v2', name: 'Corner', vat: { included: 123, ratePercent: 14 } },
    ])).toEqual([{ vendorId: 'v1', label: 'Aarna VAT 14%', amount: 42 }]);
    expect(cartVatAddedRows(undefined)).toEqual([]);
  });
  it('a placed order\'s row from its frozen VAT; none on an order whose VAT is inside its goods', () => {
    expect(orderVatAddedRow({ vatOnTop: true, vatRateBps: 1400, taxAmount: 42 })).toEqual({ label: 'VAT 14%', amount: 42 });
    expect(orderVatAddedRow({ vatOnTop: false, vatRateBps: 1400, vatAmount: 123 })).toBeNull();
    expect(ratePercentWords(12.5)).toBe('12.5');
  });
  it('the store\'s money card names the VAT it collects through the server\'s own line (this page is at its size ceiling)', () => {
    const line = 'Includes VAT 14% added at checkout: $42 (yours, for the GRA)';
    const o = {
      id: 'o', orderNumber: 'SW-1', status: 'ACCEPTED', orderType: 'FOOD_DELIVERY', placedAt: '2026-11-13T12:00:00.000Z',
      totalAmount: 1942, subtotalCustomer: 900, subtotalBase: 900, deliveryFee: 800, tipAmount: 200, discount: 0,
      taxAmount: 42, vatOnTop: true, vatRateBps: 1400, paymentMethod: 'CASH',
      storeMoney: { food: 942, foodWord: 'Food', foodLabel: 'Food — you receive', swiftPaysYou: 0, delivery: 'SWIFT_RIDER', payment: 'CASH', riderFeeAndTip: 1000, yoursFeeAndTip: 0, customerPaysYou: null, lines: [line] },
    } as unknown as VendorOrder;
    expect(orderMoneyNotes(o)).toContain(line);
    expect(orderMoneyRows(o).find((r) => r.strong)?.value).toBe(942);
  });
});

describe('the store owner\'s words', () => {
  it('the server\'s choices, in its order; an older server\'s two otherwise', () => {
    expect(vatModeChoices(['PRICES_EXCLUDE_VAT', 'PRICES_INCLUDE_VAT']).map((c) => c.label)).toEqual(['My prices are before VAT (VAT is added at checkout)', 'My prices already include VAT']);
    expect(vatModeChoices(undefined).map((c) => c.value)).toEqual(['PRICES_INCLUDE_VAT', 'ADD_VAT_AT_CHECKOUT']);
    expect(vatModeLabel('PRICES_EXCLUDE_VAT')).toBe('My prices are before VAT (VAT is added at checkout)');
    expect(vatModeHelp('PRICES_EXCLUDE_VAT', 14)).toContain('14% VAT is added at checkout as its own line before the total');
    expect(beforeVatAtCheckoutHint(14)).toBe('Before VAT. 14% VAT is added at checkout for standard-rated items.');
  });
});
