import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { OrdersBoard } from '@/test/orders-board';
import { mockApi, withOpenBoard, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder, wireVendorOrderDetail } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [APP-PREPTIME ROUND 2 · owner ruling 14 Nov 2026] The website's Accept asks
// the preparation time with the STORE'S OWN declared prep time pre-selected
// (the order carries Vendor.estimatedPrepTime from checkout), or the closest
// choice, exactly as the app does; staff can pick another. It used to start
// every order at 20. The board card's one-tap Accept sends nothing, so the
// order keeps the store's own time: the same answer.
// [REVIEW-B F3] The order window's "Quoted prep time" line says the time the
// choice holds while Accept is asked, never a second number.
// ---------------------------------------------------------------------------

const writes: Array<{ method: string; path: string; body: unknown }> = [];

function api(orders: Array<Record<string, unknown>>) {
  return mockApi(withOpenBoard((request: ApiRequest) => {
    const { method, url, init } = request;
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') { writes.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null }); return { body: { success: true, data: {} } }; }
    if (path === '/vendor/orders') return { body: { success: true, data: orders, meta: { total: orders.length } } };
    if (path.startsWith('/vendor/orders/')) {
      const row = orders.find((o) => path.endsWith(`/${String(o['id'])}`)) ?? orders[0]!;
      return { body: { success: true, data: wireVendorOrderDetail({ ...row, items: undefined }) } };
    }
    return { status: 404, body: { success: false } };
  }));
}
const pending = (id: string, orderNumber: string, estimatedPrepTime: number | null) =>
  wireVendorOrder({ id, orderNumber, status: 'PENDING', estimatedPrepTime });
const popupOf = async () => (await screen.findByText(/View later/)).closest('div.fixed') as HTMLElement;
const prepIn = (el: HTMLElement) => within(el).getByRole('combobox', { name: 'Preparation time' }) as HTMLSelectElement;
const accepts = () => writes.filter((w) => w.path.endsWith('/accept'));

beforeEach(async () => {
  writes.length = 0;
  stubAudioContext();
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[ROUND 2] the new-order popup starts at the store\'s own prep time', () => {
  it('a store that declared 45: 45 pre-selected, and one tap on Accept sends 45', async () => {
    api([pending('o-45', 'SW-9101', 45)]);
    const view = renderWithQuery(<OrdersBoard />);
    const popup = await popupOf();
    expect(prepIn(popup).value).toBe('45');
    await view.user.click(within(popup).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accepts()).toEqual([{ method: 'PUT', path: '/vendor/orders/o-45/accept', body: { estimatedPrepTime: 45 } }]));
  });

  it('a store that declared 25: the closest choice, halfway taken longer, 30; staff can pick another', async () => {
    api([pending('o-25', 'SW-9102', 25)]);
    const view = renderWithQuery(<OrdersBoard />);
    const popup = await popupOf();
    expect(prepIn(popup).value).toBe('30');
    fireEvent.change(prepIn(popup), { target: { value: '15' } });
    expect(prepIn(popup).value).toBe('15');
    await view.user.click(within(popup).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accepts()).toEqual([{ method: 'PUT', path: '/vendor/orders/o-25/accept', body: { estimatedPrepTime: 15 } }]));
  });

  it('an order with no declared time starts at 30, never 20', async () => {
    api([pending('o-none', 'SW-9103', null)]);
    renderWithQuery(<OrdersBoard />);
    expect(prepIn(await popupOf()).value).toBe('30');
  });
});

describe('[ROUND 2] the order window starts at the store\'s own prep time', () => {
  it('15 pre-selected and quoted; a pick changes both; Accept sends the pick', async () => {
    api([pending('o-15', 'SW-9104', 15)]);
    const view = renderWithQuery(<OrdersBoard />);
    await view.user.click(await screen.findByText(/View later/));
    await view.user.click(await screen.findByText('#SW-9104'));
    const dialog = await screen.findByRole('dialog', { name: 'Order details' });
    await waitFor(() => expect(prepIn(dialog).value).toBe('15'));
    expect(dialog.textContent).toContain('Quoted prep time: 15 min');
    fireEvent.change(prepIn(dialog), { target: { value: '60' } });
    expect(dialog.textContent).toContain('Quoted prep time: 60 min');
    expect(dialog.textContent).not.toContain('Quoted prep time: 15 min');
    await view.user.click(within(dialog).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accepts()).toEqual([{ method: 'PUT', path: '/vendor/orders/o-15/accept', body: { estimatedPrepTime: 60 } }]));
  });
});

describe('[ROUND 2] the board card\'s one-tap Accept keeps the store\'s own time', () => {
  it('sends nothing, so the order keeps the time it was placed with', async () => {
    api([pending('o-card', 'SW-9105', 45)]);
    const view = renderWithQuery(<OrdersBoard />);
    await view.user.click(await screen.findByText(/View later/));
    const card = (await screen.findAllByRole('article')).find((a) => a.textContent?.includes('#SW-9105'))!;
    await view.user.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accepts()).toEqual([{ method: 'PUT', path: '/vendor/orders/o-card/accept', body: {} }]));
  });
});
