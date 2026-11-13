import { describe, expect, it } from 'vitest';
import {
  beforeVatAtCheckoutHint, cartVatAdded, itemVatNote, orderVatLine, orderVatRow, storeVatStatusLine, storefrontVat, storefrontVatLine,
  vatClassChoices, vatModeChoices, vatModeHelp, vatModeLabel, vatPricingOf,
} from './storeVat';
import { cartVatAddedRows, cartVatRows, type CartQuote } from '../modules/cart/cartQuote';

// ---------------------------------------------------------------------------
// [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] A store pricing BEFORE VAT on the phone: its prices exactly as typed with
// "+ VAT" beside standard-rated items, the page note "Prices exclude VAT; VAT 14% is added at checkout", and a "VAT 14%"
// row (the server's amount, inside the server's total) right above the Total in the cart and on the order. The phone
// never computes VAT or holds a rate.
// ---------------------------------------------------------------------------

describe('the storefront', () => {
  const added = storefrontVat({ pricesIncludeVat: false, addedAtCheckout: true, ratePercent: 14 });
  it('reads the prices-before-VAT shape, and still the VAT-inclusive one', () => {
    expect(added).toEqual({ pricesIncludeVat: false, addedAtCheckout: true, ratePercent: 14 });
    expect(storefrontVat({ pricesIncludeVat: true, ratePercent: 14 })).toEqual({ pricesIncludeVat: true, ratePercent: 14 });
    expect(storefrontVat({ pricesIncludeVat: false, ratePercent: 14 })).toBeNull();
    expect(storefrontVat(null)).toBeNull();
  });
  it('"+ VAT" beside a standard-rated price, nothing beside zero-rated or exempt; the price itself is never changed', () => {
    expect(itemVatNote(added, { vatClass: 'STANDARD' })).toBe('+ VAT');
    expect(itemVatNote(added, {})).toBe('+ VAT');
    expect(itemVatNote(added, { vatClass: 'ZERO_RATED' })).toBeNull();
    expect(itemVatNote(storefrontVat({ pricesIncludeVat: true, ratePercent: 14 }), { vatClass: 'STANDARD' })).toBe('incl. VAT');
  });
  it('the page says prices exclude VAT and VAT is added at checkout (VAT Act s.90 caution)', () => {
    expect(storefrontVatLine(added)).toBe('Prices exclude VAT; VAT 14% is added at checkout. Zero-rated and exempt items carry none.');
  });
});

describe('the cart: "VAT 14%" above the Total, from the server', () => {
  const store = (vendorId: string, name: string, vat: unknown) =>
    ({ vendorId, name, fulfillment: 'DELIVERY', subtotal: 900, deliveryFee: 800, minOrderAmount: 0, meetsMinimum: true, vat });
  const added = { added: 42, ratePercent: 14, standardGoods: 300, zeroRatedGoods: 600, exemptGoods: 0 };
  it('one store pricing before VAT: one "VAT 14%" row, and no "Includes VAT" note', () => {
    const quote = { vendors: [store('v1', 'Aarna', added)] } as CartQuote;
    expect(cartVatAddedRows(quote)).toEqual([{ vendorId: 'v1', label: 'VAT 14%', amount: 42 }]);
    expect(cartVatRows(quote)).toEqual([]);
  });
  it('several stores: each store pricing before VAT, named; a VAT-inclusive store keeps its note', () => {
    const quote = { vendors: [store('v1', 'Aarna', added), store('v2', 'Corner', { included: 123, ratePercent: 14 }), store('v3', 'Plain', null)] } as CartQuote;
    expect(cartVatAddedRows(quote)).toEqual([{ vendorId: 'v1', label: 'Aarna VAT 14%', amount: 42 }]);
    expect(cartVatRows(quote).map((r) => r.vendorId)).toEqual(['v2']);
  });
  it('an older server (no `added`) or no VAT: no row', () => {
    expect(cartVatAddedRows({ vendors: [store('v3', 'Plain', null)] } as CartQuote)).toEqual([]);
    expect(cartVatAdded({ included: 123, ratePercent: 14 })).toBeNull();
    expect(cartVatAddedRows(null)).toEqual([]);
  });
});

describe('a placed order', () => {
  it('VAT on top: the "VAT 14%" row with the frozen amount; the note names who charges it', () => {
    const o = { vatOnTop: true, vatRateBps: 1400, taxAmount: 42, vatAmount: 42, vatSellerName: 'Aarna Ltd' };
    expect(orderVatRow(o)).toEqual({ label: 'VAT 14%', amount: 42 });
    expect(orderVatLine(o)).toBe('VAT charged by Aarna Ltd');
  });
  it('VAT inside the goods (or none): no row; the note is unchanged', () => {
    expect(orderVatRow({ vatOnTop: false, vatRateBps: 1400, vatAmount: 123 })).toBeNull();
    expect(orderVatLine({ vatRateBps: 1400, vatAmount: 123 })).toBe('Includes VAT of $123 (14%)');
    expect(orderVatRow({ vatRateBps: null })).toBeNull();
    expect(orderVatRow(null)).toBeNull();
  });
});

describe('the store owner\'s words', () => {
  it('the choices are the server\'s, in its order; an older server\'s two otherwise', () => {
    expect(vatModeChoices(['PRICES_EXCLUDE_VAT', 'PRICES_INCLUDE_VAT']).map((c) => c.label)).toEqual([
      'My prices are before VAT (VAT is added at checkout)', 'My prices already include VAT',
    ]);
    expect(vatModeChoices(undefined).map((c) => c.value)).toEqual(['PRICES_INCLUDE_VAT', 'ADD_VAT_AT_CHECKOUT']);
    expect(vatModeLabel('ADD_VAT_AT_CHECKOUT')).toBe('My prices do not include VAT');
  });
  it('help, the approved status line, the class words and the price hint name the VAT line at checkout', () => {
    expect(vatModeHelp('PRICES_EXCLUDE_VAT', 14)).toContain('customers see the prices you type (before VAT)');
    expect(vatModeHelp('PRICES_EXCLUDE_VAT', 14)).toContain('14% VAT is added at checkout as its own line before the total');
    const approved = storeVatStatusLine({
      status: 'APPROVED', mode: 'PRICES_EXCLUDE_VAT', effective: true, ratePercent: 14, reviewNote: null, certificate: null,
      approved: { number: '012345678', registeredName: 'Aarna Ltd', effectiveFrom: '2026-01-01T00:00:00.000Z' },
    });
    expect(approved).toContain('Your prices are shown before VAT, and VAT at 14% is added at checkout as its own line');
    expect(vatClassChoices(14, true, true)[0]!.label).toBe('Standard (14% VAT added at checkout)');
    expect(vatClassChoices(14, true)[0]!.label).toBe('Standard (14% VAT inside the price)');
    expect(beforeVatAtCheckoutHint(14)).toBe('Before VAT. 14% VAT is added at checkout for standard-rated items.');
  });
  it('the profile word: prices before VAT are labelled so, but nothing is added into them (adds stays false)', () => {
    expect(vatPricingOf({ vatAddsToPrices: false, vatRatePercent: 14, vatPricesBeforeVat: true })).toEqual({ adds: false, ratePercent: 14, beforeVat: true });
    expect(vatPricingOf({ vatAddsToPrices: true, vatRatePercent: 14 })).toEqual({ adds: true, ratePercent: 14, beforeVat: false });
  });
});
