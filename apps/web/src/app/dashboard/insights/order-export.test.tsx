import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InsightsPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// [ORDER-EXPORT · owner 11 Nov 2026] Insights offers owners and managers "Export orders (CSV)": a range of days and,
// for several branches, one branch or all of them. Staff never see it (the server refuses them too).
const store = (id: string, name: string) => ({ id, name, vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: 'Georgetown', isVerified: true, status: 'ACTIVE', awaitingApproval: false });
const overview = { vendor: { totalOrders: 3 }, today: { orders: 1, revenue: 1000 }, week: { orders: 2, revenue: 2000 }, month: { orders: 3, revenue: 3000 }, activeMenuItems: 4 };

function api(opts: { stores: unknown[]; role: string }) {
  return mockApi(({ url }: ApiRequest) => {
    if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: opts.stores, selectedId: 'camp', myRole: opts.role } } };
    if (url.pathname === '/api/v1/vendor/analytics/overview') return { body: { data: overview } };
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => {
  (await import('@/lib/auth')).setSelectedStore('camp');
});

describe('[ORDER-EXPORT] Insights: Export orders', () => {
  it('a staff member never sees it', async () => {
    api({ stores: [store('camp', 'Royal Camp')], role: 'STAFF' });
    renderWithQuery(<InsightsPage />);
    expect(await screen.findByText(/Insights are for the store/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export orders (CSV)' })).toBeNull();
  });

  it('a chain owner exports all branches for the chosen days, saved under the server\'s file name', async () => {
    const created = vi.fn((_blob: Blob) => 'blob:orders');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const base = api({ stores: [store('camp', 'Royal Camp'), store('north', 'Royal North')], role: 'OWNER' });
    const { user } = renderWithQuery(<InsightsPage />);
    const button = await screen.findByRole('button', { name: 'Export orders (CSV)' });
    const asked: URL[] = [];
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const appended = vi.spyOn(document.body, 'appendChild');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/vendor/orders/export') {
        asked.push(url);
        expect((init?.headers as Record<string, string>)['x-vendor-id']).toBe('camp');
        return new Response('order_number\nSW-1', { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="swift-orders-all-branches-2026-10-01-to-2026-10-31.csv"' } });
      }
      return base(input, init);
    }));
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-10-01');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-10-31');
    await user.selectOptions(screen.getByLabelText('Branch'), 'all');
    await user.click(button);
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(clicked).toHaveBeenCalledTimes(1);
    const saved = appended.mock.calls.map(([node]) => node).filter((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement).map((a) => a.download);
    expect(saved).toEqual(['swift-orders-all-branches-2026-10-01-to-2026-10-31.csv']);
    appended.mockRestore();
    expect(Object.fromEntries(asked[0]!.searchParams)).toEqual({ from: '2026-10-01', to: '2026-10-31', branch: 'all' });
    expect(await screen.findByText('Downloaded.')).toBeTruthy();
    clicked.mockRestore();
  });

  it('one store: no branch choice; the server\'s refusal is shown in its words', async () => {
    const base = api({ stores: [store('camp', 'Royal Camp')], role: 'MANAGER' });
    const { user } = renderWithQuery(<InsightsPage />);
    const button = await screen.findByRole('button', { name: 'Export orders (CSV)' });
    expect(screen.queryByLabelText('Branch')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/v1/vendor/orders/export')) {
        expect(new URL(String(input)).searchParams.get('branch')).toBe('camp');
        return new Response(JSON.stringify({ success: false, error: { code: 'EXPORT_RANGE_TOO_LONG', message: 'One file covers at most 366 days. Choose a shorter range.' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      return base(input, init);
    }));
    await user.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe('One file covers at most 366 days. Choose a shorter range.');
  });
});
