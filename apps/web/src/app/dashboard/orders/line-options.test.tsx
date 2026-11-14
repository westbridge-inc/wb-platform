import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext } from '@/test/test-utils';
import { wireOrderLine, wireVendorOrderDetail } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [L09 · M026 · MENU-OPTIONS · owner 11 Nov 2026] The web order window shows what the customer chose on each line, as
// the app's order screens do (apps/mobile/src/modules/vendor/orderLineOptions.ts, imported as is): a pizza reads
// "Large", "Crust: Stuffed crust → Cheese: Cheddar", "Toppings — Left: Pepperoni / Right: Mushroom / Whole: Onion",
// one group per line. Before this the website showed no options at all, so the kitchen could make the wrong pizza.
// ---------------------------------------------------------------------------

const PIZZA_OPTIONS = [
  { group: 'Size', name: 'Large', price: 0, plainGroup: 'Size', plainName: 'Large', placement: null, parentOptionName: null, setsPrice: true },
  { group: 'Crust', name: 'Stuffed crust', price: 300, plainGroup: 'Crust', plainName: 'Stuffed crust', placement: null, parentOptionName: null, setsPrice: false },
  { group: 'Cheese (Stuffed crust)', name: 'Cheddar', price: 0, plainGroup: 'Cheese', plainName: 'Cheddar', placement: null, parentOptionName: 'Stuffed crust', setsPrice: false },
  { group: 'Toppings', name: 'Pepperoni (left half)', price: 200, plainGroup: 'Toppings', plainName: 'Pepperoni', placement: 'LEFT', parentOptionName: null, setsPrice: false },
  { group: 'Toppings', name: 'Mushroom (right half)', price: 150, plainGroup: 'Toppings', plainName: 'Mushroom', placement: 'RIGHT', parentOptionName: null, setsPrice: false },
  { group: 'Toppings', name: 'Onion', price: 100, plainGroup: 'Toppings', plainName: 'Onion', placement: 'WHOLE', parentOptionName: null, setsPrice: false },
];

async function openDetail(items: unknown[]) {
  const server = wireVendorOrderDetail({ status: 'PREPARING', items });
  mockApi((request) => {
    const path = request.url.pathname;
    if (request.method === 'GET' && path === '/api/v1/vendor/orders') return { body: { success: true, data: [server], meta: { total: 1 } } };
    if (request.method === 'GET' && path === '/api/v1/vendor/orders/order-live') return { body: { success: true, data: server } };
    if (request.method === 'GET' && path === '/api/v1/vendor/items') return { body: { success: true, data: [] } };
    return { status: 404, body: { success: false } };
  });
  const { user } = renderWithQuery(<OrdersPage />);
  const heading = await screen.findByText('#SW-1001');
  const later = screen.queryByText(/View later/);
  if (later) await user.click(later);
  await user.click(heading.closest('button')!);
  return screen.findByRole('dialog', { name: 'Order details' });
}

beforeEach(() => stubAudioContext());

describe('[MENU-OPTIONS] the web order window reads a pizza as the kitchen needs it', () => {
  it('the size, the follow-up under its opener, and the toppings by half, one group per line', async () => {
    const dialog = await openDetail([wireOrderLine({ name: 'Pizza', quantity: 1, totalCustomer: '4100.00', specialInstructions: null, options: PIZZA_OPTIONS })]);
    const parts = (await within(dialog).findAllByTestId('order-line-option')).map((el) => el.textContent);
    expect(parts).toEqual([
      'Large',
      'Crust: Stuffed crust → Cheese: Cheddar',
      'Toppings — Left: Pepperoni / Right: Mushroom / Whole: Onion',
    ]);
  });

  it('a line from an older server (display words only) reads "group: name"; a line with no options shows none', async () => {
    const dialog = await openDetail([
      wireOrderLine({ name: 'Roti', options: [{ group: 'Size', name: 'Large', price: 0 }, { group: 'Extras', name: 'Cheese', price: 100 }] }),
      wireOrderLine({ id: 'line-2', itemId: 'item-2', name: 'Plantain', quantity: 1, totalCustomer: '1000.00', specialInstructions: null, options: [] }),
    ]);
    const parts = (await within(dialog).findAllByTestId('order-line-option')).map((el) => el.textContent);
    expect(parts).toEqual(['Size: Large', 'Extras: Cheese']);
  });
});
