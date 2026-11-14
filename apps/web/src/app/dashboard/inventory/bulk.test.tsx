import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import InventoryPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [MENU-BULK · parity audit C2, owner 14 Nov 2026] As on the app: "Select" puts a tick on every row; a bar at the
// bottom counts the ticks and offers "Select all shown", "Clear", "Mark sold out" and "Make available"; the store is
// asked first (how many, what happens); ONE request (POST /vendor/items/availability/bulk); the answer is counted on
// the page in the app's words (lib/bulkAvailability), and the list is read again.

let items: Array<Record<string, unknown>>;
let sent: Array<Record<string, unknown>>;
let answer: Record<string, unknown> | null;
beforeEach(() => {
  sent = [];
  answer = null;
  items = [
    { id: 'i1', name: 'Fried Chicken', basePrice: '900.00', stockQuantity: null, isAvailable: true, category: { id: 'c1', name: 'Mains' } },
    { id: 'i2', name: 'Chicken Curry', basePrice: '1200.00', stockQuantity: null, isAvailable: true, category: { id: 'c1', name: 'Mains' } },
    { id: 'i3', name: 'Mauby', basePrice: '300.00', stockQuantity: null, isAvailable: true, category: { id: 'c2', name: 'Drinks' } },
  ];
  mockApi(({ url, method, init }) => {
    if (url.pathname === '/api/v1/vendor/items/availability/bulk' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { itemIds: string[]; isAvailable: boolean };
      sent.push(body);
      if (answer) return answer as never;
      items = items.map((row) => (body.itemIds.includes(String(row.id)) ? { ...row, isAvailable: body.isAvailable } : row));
      return { body: { success: true, data: { isAvailable: body.isAvailable, changedIds: body.itemIds, unchangedIds: [], refused: [] } } };
    }
    if (url.pathname === '/api/v1/vendor/items' && method === 'GET') return { body: { data: items } };
    if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [{ id: 'c1', name: 'Mains' }, { id: 'c2', name: 'Drinks' }] } };
    if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole: 'OWNER' } } };
    if (url.pathname === '/api/v1/vendor/profile') return { body: { data: { myRole: 'OWNER', vendors: [] } } };
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
});

const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };
const button = (name: string) => screen.getByRole('button', { name });
const tickOf = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` }) as HTMLInputElement;
const bar = () => screen.getByRole('region', { name: 'Selected items' });

describe('[MENU-BULK] several items at once on the website', () => {
  it('"Select" puts a tick on every row; Done takes them away', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Mauby' });
    expect(screen.queryByRole('checkbox', { name: 'Select Mauby' })).toBeNull();
    await click(button('Select'));
    expect(tickOf('Mauby').checked).toBe(false);
    expect(within(bar()).getByText('0 selected')).toBeTruthy();
    expect((within(bar()).getByRole('button', { name: 'Mark sold out' }) as HTMLButtonElement).disabled).toBe(true);
    await click(button('Done'));
    expect(screen.queryByRole('checkbox', { name: 'Select Mauby' })).toBeNull();
  });

  it('tick two, Mark sold out, the ask names how many; yes sends ONE request; the answer is counted and the list re-read', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Mauby' });
    await click(button('Select'));
    await click(tickOf('Fried Chicken'));
    await click(tickOf('Chicken Curry'));
    expect(within(bar()).getByText('2 selected')).toBeTruthy();
    await click(within(bar()).getByRole('button', { name: 'Mark sold out' }));
    const ask = screen.getByRole('dialog', { name: 'Mark 2 items sold out?' });
    expect(sent).toHaveLength(0);
    await click(within(ask).getByRole('button', { name: 'Yes, mark sold out' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ itemIds: ['i1', 'i2'], isAvailable: false });
    expect(await screen.findByText('2 items marked sold out.')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Fried Chicken' })).getByRole('switch').getAttribute('aria-checked')).toBe('false'));
    expect(screen.queryByRole('checkbox', { name: 'Select Mauby' }), 'select mode ends').toBeNull();
  });

  it('"Select all shown" ticks what the search shows; "Clear" unticks', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Mauby' });
    await click(button('Select'));
    await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'Search name or SKU' }), { target: { value: 'chicken' } }); });
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Mauby' })).toBeNull());
    await click(within(bar()).getByRole('button', { name: 'Select all shown' }));
    expect(within(bar()).getByText('2 selected')).toBeTruthy();
    await click(within(bar()).getByRole('button', { name: 'Clear' }));
    expect(within(bar()).getByText('0 selected')).toBeTruthy();
  });

  it('Make available, with an item Swift does not allow named in the answer', async () => {
    items = items.map((row) => ({ ...row, isAvailable: false }));
    answer = { body: { success: true, data: { isAvailable: true, changedIds: ['i3'], unchangedIds: [], refused: [{ id: 'i1', name: 'Fried Chicken', message: 'x' }] } } };
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Mauby' });
    await click(button('Select'));
    await click(tickOf('Fried Chicken'));
    await click(tickOf('Mauby'));
    await click(within(bar()).getByRole('button', { name: 'Make available' }));
    await click(within(screen.getByRole('dialog', { name: 'Make 2 items available?' })).getByRole('button', { name: 'Yes, make available' }));
    expect(await screen.findByText('1 item made available. Swift does not allow 1, so it stays off: Fried Chicken.')).toBeTruthy();
  });

  it('Cancel sends nothing; a refusal says why and keeps the ticks', async () => {
    answer = { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Item with id in this batch not found' } } };
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Mauby' });
    await click(button('Select'));
    await click(tickOf('Mauby'));
    await click(within(bar()).getByRole('button', { name: 'Mark sold out' }));
    await click(within(screen.getByRole('dialog', { name: 'Mark 1 item sold out?' })).getByRole('button', { name: 'Cancel' }));
    expect(sent).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    await click(within(bar()).getByRole('button', { name: 'Mark sold out' }));
    await click(within(screen.getByRole('dialog', { name: 'Mark 1 item sold out?' })).getByRole('button', { name: 'Yes, mark sold out' }));
    expect(await within(bar()).findByText(/not found/)).toBeTruthy();
    expect(tickOf('Mauby').checked).toBe(true);
  });
});
