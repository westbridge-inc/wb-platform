import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn(async (_path: string, _init?: RequestInit) => ({ data: {} })));
vi.mock('./auth', () => ({ apiFetch, getSessionPrincipal: vi.fn() }));

import { CART_WRITE_CAPABILITIES, addToCart, checkout, updateCartLine } from './customer';
import { MENU_OPTIONS_CAPABILITY, VAT_LINE_CAPABILITY, customerOrderCapabilities } from '../../../mobile/src/lib/menuOptionsCapability';
import { reorder } from './customer-orders';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] Every cart write from the website says it shows sizes that set the price,
// halves and follow-up choices (MENU_OPTIONS_V2). Without it the server refuses such an item with 409
// APP_UPDATE_REQUIRED, an "update the app" the website can never act on. (The basket upload is pinned in
// basket-merge.test.ts.) Synthetic ids only.
// ---------------------------------------------------------------------------

beforeEach(() => apiFetch.mockClear());

describe('[MENU-OPTIONS] the website’s cart writes declare MENU_OPTIONS_V2', () => {
  it('the word the client sends is the app\'s own capability (one word on every surface)', () => {
    expect(CART_WRITE_CAPABILITIES).toEqual(customerOrderCapabilities());
    expect(CART_WRITE_CAPABILITIES).toEqual([MENU_OPTIONS_CAPABILITY, VAT_LINE_CAPABILITY]);
  });

  it('an add sends the choices as the API reads them, and the capability', async () => {
    await addToCart({ vendorId: 'store-1', itemId: 'pizza-1', quantity: 1, selectedOptions: { size: 'large', toppings: ['pep:left'] } });
    const [path, init] = apiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/customer/cart/items');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({
      vendorId: 'store-1', itemId: 'pizza-1', quantity: 1, selectedOptions: { size: 'large', toppings: ['pep:left'] }, capabilities: ['MENU_OPTIONS_V2', 'VAT_LINE_V1'],
    });
  });

  it('a quantity change sends it too', async () => {
    await updateCartLine('line-1', 2);
    const [path, init] = apiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/customer/cart/items/line-1');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init!.body))).toEqual({ quantity: 2, capabilities: ['MENU_OPTIONS_V2', 'VAT_LINE_V1'] });
  });

  it('a reorder sends it too (the server asks a client without it to update)', async () => {
    await reorder('order-1');
    const [path, init] = apiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/customer/orders/order-1/reorder');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({ capabilities: ['MENU_OPTIONS_V2'] });
  });
});

describe('[STORE-VAT-EXCLUSIVE · REVIEW-A F3] the website shows a store\'s "VAT 14%" line, and says so on checkout', () => {
  it('the checkout body carries VAT_LINE_V1 (the server refuses a basket with a store pricing before VAT without it)', async () => {
    await checkout({ paymentMethod: 'CASH', expectedTotal: 914 } as never, 'attempt-key-0001');
    const [path, init] = apiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/customer/checkout');
    expect(JSON.parse(String(init!.body))).toEqual({ paymentMethod: 'CASH', expectedTotal: 914, capabilities: ['MENU_OPTIONS_V2', 'VAT_LINE_V1'] });
  });
});

