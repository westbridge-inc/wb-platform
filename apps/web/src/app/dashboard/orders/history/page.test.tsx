import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrderHistoryPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [WEB-HISTORY · audit B2 + C5] The website's Order history copies the phone's VendorOrderHistoryScreen:
// "Search order # or customer", the All / Delivered / Completed / Cancelled buttons and "Load more" pages
// of 20, from the same server read (GET /vendor/orders). Before, the website could only press the board's
// "Done" button over the newest 50 orders: anything older could not be reached. The website also picks a
// range of days (the server already takes `from` and `to`), as Guyana days.
// ---------------------------------------------------------------------------

type Row = { id: string; orderNumber: string; status: string; placedAt: string; subtotalCustomer: string; discount: string; customer: { id: string; firstName: string } | null; items: unknown[] };
const order = (n: number, status = 'DELIVERED'): Row => ({
  id: `o${n}`, orderNumber: `SW-${1000 + n}`, status, placedAt: '2026-11-01T15:00:00.000Z',
  subtotalCustomer: '1500.00', discount: '0.00', customer: { id: `c${n}`, firstName: n % 2 ? 'Asha' : 'Ravi' },
  items: [{ id: `l${n}`, itemId: 'i1', name: 'Pepperpot', quantity: 1, totalCustomer: '1500.00' }],
});

const reads: URL[] = [];
function historyApi(opts: { total?: number; fail?: boolean; rows?: (_url: URL) => Row[] } = {}) {
  const total = opts.total ?? 45;
  return mockApi(({ url, method }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/vendor/stores') {
      return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: 'OWNER' } } };
    }
    if (path === '/vendor/orders' && method === 'GET') {
      reads.push(url);
      if (opts.fail) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      const page = Number(url.searchParams.get('page'));
      const limit = Number(url.searchParams.get('limit'));
      const rows = opts.rows ? opts.rows(url) : Array.from({ length: Math.max(0, Math.min(limit, total - (page - 1) * limit)) }, (_, i) => order((page - 1) * limit + i + 1));
      const all = opts.rows ? rows.length : total;
      return { body: { success: true, data: rows, meta: { page, limit, total: all, totalPages: Math.ceil(all / limit), hasNext: page * limit < all, hasPrev: page > 1 } } };
    }
    return { status: 404, body: { success: false } };
  });
}

const lastRead = () => reads[reads.length - 1]!;
const rows = () => screen.queryAllByRole('button', { name: /^Order SW-/ });

beforeEach(async () => {
  reads.length = 0;
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[WEB-HISTORY] Order history on the website, as on the phone', () => {
  it('asks the server for the newest 20 orders of any status and lists them with the store\'s own money', async () => {
    historyApi();
    renderWithQuery(<OrderHistoryPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Order history' })).toBeTruthy();
    await waitFor(() => expect(rows()).toHaveLength(20));
    const first = reads[0]!;
    expect(first.searchParams.get('page')).toBe('1');
    expect(first.searchParams.get('limit')).toBe('20');
    expect(first.searchParams.has('status')).toBe(false);
    expect(first.searchParams.has('search')).toBe(false);
    expect(first.searchParams.has('from')).toBe(false);
    const row = rows()[0]!;
    expect(row.textContent).toContain('#SW-1001');
    expect(row.textContent).toContain('Delivered');
    expect(row.textContent).toContain('Asha');
    expect(row.textContent).toContain('1 item');
    expect(row.textContent).toContain('1,500');
    expect(await screen.findByText(/Sample Kitchen · 45 orders/)).toBeTruthy();
  });

  it('"Load more" reads the next page and adds it under the list, until "That\'s everything"', async () => {
    historyApi({ total: 45 });
    const { user } = renderWithQuery(<OrderHistoryPage />);
    await waitFor(() => expect(rows()).toHaveLength(20));
    await user.click(screen.getByRole('button', { name: 'Load more (20 of 45)' }));
    await waitFor(() => expect(rows()).toHaveLength(40));
    expect(lastRead().searchParams.get('page')).toBe('2');
    expect(rows()[20]!.textContent).toContain('#SW-1021');
    await user.click(screen.getByRole('button', { name: 'Load more (40 of 45)' }));
    await waitFor(() => expect(rows()).toHaveLength(45));
    expect(lastRead().searchParams.get('page')).toBe('3');
    expect(screen.getByText('That’s everything')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Load more/ })).toBeNull();
  });

  it('searches by order number or customer on the server, from the first page, the list replaced', async () => {
    historyApi({ rows: (url) => (url.searchParams.get('search') === 'asha' ? [order(7)] : Array.from({ length: 20 }, (_, i) => order(i + 1))) });
    const { user } = renderWithQuery(<OrderHistoryPage />);
    await waitFor(() => expect(rows()).toHaveLength(20));
    await user.type(screen.getByPlaceholderText('Search order # or customer'), '  asha ');
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(lastRead().searchParams.get('search')).toBe('asha');
    expect(lastRead().searchParams.get('page')).toBe('1');
    expect(rows()[0]!.textContent).toContain('#SW-1007');
  });

  it('the status buttons ask the server for that status, from the first page', async () => {
    historyApi({ rows: (url) => (url.searchParams.get('status') === 'CANCELLED' ? [order(3, 'CANCELLED')] : [order(1), order(2, 'COMPLETED')]) });
    const { user } = renderWithQuery(<OrderHistoryPage />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const filters = screen.getByRole('group', { name: 'Show orders' });
    expect(within(filters).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Delivered', 'Completed', 'Cancelled']);
    expect(within(filters).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(filters).getByRole('button', { name: 'Cancelled' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(lastRead().searchParams.get('status')).toBe('CANCELLED');
    expect(lastRead().searchParams.get('page')).toBe('1');
    expect(within(filters).getByRole('button', { name: 'Cancelled' }).getAttribute('aria-pressed')).toBe('true');
    expect(rows()[0]!.textContent).toContain('Cancelled');
  });

  it('a range of days is asked for as whole Guyana days; a start after the end is refused before any read', async () => {
    historyApi({ rows: () => [order(1)] });
    const { user } = renderWithQuery(<OrderHistoryPage />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.type(screen.getByLabelText('From'), '2026-11-01');
    await waitFor(() => expect(lastRead().searchParams.get('from')).toBe('2026-11-01T00:00:00.000-04:00'));
    expect(lastRead().searchParams.has('to')).toBe(false);
    await user.type(screen.getByLabelText('To'), '2026-11-03');
    await waitFor(() => expect(lastRead().searchParams.get('to')).toBe('2026-11-03T23:59:59.999-04:00'));
    expect(lastRead().searchParams.get('from')).toBe('2026-11-01T00:00:00.000-04:00');
    expect(lastRead().searchParams.get('page')).toBe('1');
    const before = reads.length;
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-11-09');
    expect((await screen.findByRole('alert')).textContent).toBe('Choose a start day on or before the end day.');
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(reads.slice(before).some((url) => url.searchParams.get('from') === '2026-11-09T00:00:00.000-04:00')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Clear days' }));
    await waitFor(() => expect(lastRead().searchParams.has('from')).toBe(false));
    expect(lastRead().searchParams.has('to')).toBe(false);
  });

  it('a failed read says so, never "No orders yet"', async () => {
    historyApi({ fail: true });
    renderWithQuery(<OrderHistoryPage />);
    expect(await screen.findByText(/couldn.t load your order history/i)).toBeTruthy();
    expect(screen.queryByText('No orders yet')).toBeNull();
  });

  it('no orders: "No orders yet"; nothing matching a filter: "Nothing matches"', async () => {
    historyApi({ rows: () => [] });
    const { user } = renderWithQuery(<OrderHistoryPage />);
    expect(await screen.findByText('No orders yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delivered' }));
    expect(await screen.findByText('Nothing matches')).toBeTruthy();
  });

  it('a row opens the order window, as on the board', async () => {
    historyApi({ rows: () => [order(1)] });
    const { user } = renderWithQuery(<OrderHistoryPage />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(rows()[0]!);
    expect(await screen.findByRole('dialog', { name: 'Order details' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Order details' })).toBeNull());
  });
});
