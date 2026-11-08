import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireOrderLine, wireVendorOrder } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [OOS-FLOW · owner 8 Nov 2026] "i said out of stock in dashboard but customer
// sees it but order doesnt get cancelled nor can they get a replacement".
// After the store ACCEPTED, on the web dashboard (the phone's shared rules):
//   - "Out of stock?" names both ways out: "Remove item", or offer a
//     replacement the customer approves or declines;
//   - the last item still coming asks once (the server then cancels the order
//     as out of stock and tells the customer);
//   - an order emptied on an older server says what to do, with the way out.
// ---------------------------------------------------------------------------

const writes: Array<{ method: string; path: string }> = [];
const lines = (...over: Array<Record<string, unknown>>) => over.map((o, i) => wireOrderLine({ id: `line-${i + 1}`, itemId: `item-${i + 1}`, name: `Item ${i + 1}`, ...o }));
const shop = { vendor: { vendorType: 'STORE', selfDeliveryEnabled: false }, status: 'PREPARING', paymentMethod: 'CASH' };

function api(orders: unknown[]) {
  return mockApi((request: ApiRequest) => {
    const { method, url } = request;
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') { writes.push({ method, path }); return { body: { success: true, data: {} } }; }
    if (path === '/vendor/orders') return { body: { success: true, data: orders, meta: { total: orders.length } } };
    if (path.startsWith('/vendor/orders/')) return { body: { success: true, data: orders[0] } };
    return { status: 404, body: { success: false } };
  });
}
async function openWindow(orderNumber: string, view: ReturnType<typeof renderWithQuery>) {
  const later = await screen.findByText(/View later/).catch(() => null);
  if (later) await view.user.click(later);
  await view.user.click(await screen.findByText(`#${orderNumber}`, { selector: 'p' }));
  return screen.findByRole('dialog', { name: 'Order details' });
}

beforeEach(async () => {
  writes.length = 0;
  stubAudioContext();
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[OOS-FLOW] an accepted order: remove it, or offer a replacement', () => {
  it('"Out of stock?" names both ways out; "Remove item" on a line that is not the last removes it at once', async () => {
    api([wireVendorOrder({ ...shop, id: 'o-1', orderNumber: 'SW-9101', items: lines({ name: 'Shirt' }, { name: 'Vest' }) })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-9101', view);
    await view.user.click(within(dialog).getAllByRole('button', { name: 'Out of stock?' })[1]!);
    expect(within(dialog).getByText('Out of stock — remove it, or offer a replacement:')).toBeTruthy();
    expect(within(dialog).getByText('Offer a replacement (the customer approves or declines in the app):')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Show all items' })).toBeTruthy();
    await view.user.click(within(dialog).getByRole('button', { name: 'Remove item' }));
    await waitFor(() => expect(writes.map((w) => w.path)).toEqual(['/vendor/orders/o-1/items/line-2/refund-line']));
  });

  it('the last item still coming: asked once; "Keep it" sends nothing; yes removes it (the server cancels the order)', async () => {
    api([wireVendorOrder({ ...shop, id: 'o-2', orderNumber: 'SW-9102', items: lines({ name: 'Shirt', subStatus: 'REFUNDED' }, { name: 'Vest' }) })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-9102', view);
    await view.user.click(within(dialog).getByRole('button', { name: 'Out of stock?' }));
    await view.user.click(within(dialog).getByRole('button', { name: 'Remove item' }));
    expect(writes).toEqual([]);
    expect(within(dialog).getByText(/This is the last item on the order\. Removing it cancels the order as out of stock/)).toBeTruthy();
    await view.user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(writes).toEqual([]);
    await view.user.click(within(dialog).getByRole('button', { name: 'Remove item' }));
    await view.user.click(within(dialog).getByRole('button', { name: 'Remove and cancel the order' }));
    await waitFor(() => expect(writes.map((w) => w.path)).toEqual(['/vendor/orders/o-2/items/line-2/refund-line']));
  });
});

describe('[OOS-FLOW] an order emptied on an older server is never a silent Ready refusal', () => {
  it('says why and rejects it "Out of stock" in one tap', async () => {
    api([wireVendorOrder({ ...shop, id: 'o-3', orderNumber: 'SW-9103', items: lines({ subStatus: 'REFUNDED' }) })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-9103', view);
    expect(within(dialog).getByText(/Every item on this order came off as out of stock, so there is nothing to hand over\. Reject it/)).toBeTruthy();
    await view.user.click(within(dialog).getByRole('button', { name: 'Reject: out of stock' }));
    await waitFor(() => expect(writes.map((w) => w.path)).toEqual(['/vendor/orders/o-3/reject']));
  });
});
