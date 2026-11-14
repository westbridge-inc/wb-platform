import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { setSelectedStore } from '@/lib/auth';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [STORE-BOARD S1 · parity audit 14 Nov 2026, A1] The website board asked for the newest 100 orders of any status
// (the server caps a page at 50): an order still cooking behind 50 newer orders left the board. It now reads EVERY
// open order (GET /vendor/orders/open) for its lanes, plus the newest 50 for Done; past the server's cap it says how
// many open orders it is not showing; a server without the open read (404) gets the old page, and the note.
// ---------------------------------------------------------------------------

const finished = (n: number) => Array.from({ length: n }, (_, i) => wireVendorOrder({ id: `done-${i}`, orderNumber: `SW-D${i}`, status: 'DELIVERED' }));
const cooking = wireVendorOrder({ id: 'old-cook', orderNumber: 'SW-OLD1', status: 'PREPARING' });

let open: { status: number; body: unknown };
let recent: unknown[];
let recentTotal = 0;
const reads: string[] = [];

beforeEach(() => {
  stubAudioContext();
  setSelectedStore('store-1');
  reads.length = 0;
  mockApi((request: ApiRequest) => {
    const path = request.url.pathname.replace('/api/v1', '');
    if (request.method === 'GET') reads.push(path + request.url.search);
    if (request.method === 'GET' && path === '/vendor/orders/open') return open;
    if (request.method === 'GET' && path === '/vendor/orders') return { body: { success: true, data: recent, meta: { total: recentTotal } } };
    if (request.method === 'GET' && path.startsWith('/vendor/orders/')) return { body: { success: true, data: cooking } };
    return { status: 404, body: { success: false } };
  });
});

describe('[STORE-BOARD S1] the website board shows every open order', () => {
  it('an order still cooking behind 50 newer finished orders is in the Preparing lane', async () => {
    recent = finished(50);
    recentTotal = 51;
    open = { status: 200, body: { success: true, data: [cooking], meta: { total: 1, shown: 1, notShown: 0, cap: 300 } } };
    renderWithQuery(<OrdersPage />);
    const lane = await screen.findByRole('region', { name: 'Preparing orders' });
    await waitFor(() => expect(within(lane).getByText('#SW-OLD1')).toBeTruthy());
    expect(reads).toContain('/vendor/orders/open');
    // Every open order is here: no "not shown" note.
    expect(screen.queryByTestId('board-not-shown')).toBeNull();
  });

  it('past the server\'s cap the board says how many open orders it is not showing', async () => {
    recent = [];
    open = { status: 200, body: { success: true, data: [cooking], meta: { total: 4, shown: 1, notShown: 3, cap: 300 } } };
    renderWithQuery(<OrdersPage />);
    expect((await screen.findByTestId('board-not-shown')).textContent).toBe('3 more open orders are not shown (1 of 4 shown).');
  });

  it('a server without the open read (404): the newest page as before, and the note when there are more', async () => {
    recent = [cooking, ...finished(49)];
    recentTotal = 80;
    open = { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Order with id open not found' } } };
    renderWithQuery(<OrdersPage />);
    const lane = await screen.findByRole('region', { name: 'Preparing orders' });
    await waitFor(() => expect(within(lane).getByText('#SW-OLD1')).toBeTruthy());
    expect((await screen.findByTestId('board-not-shown')).textContent).toBe('Showing the newest 50 orders — older open orders may not be shown.');
  });

  it('an order on both reads is drawn once', async () => {
    recent = [cooking];
    recentTotal = 1;
    open = { status: 200, body: { success: true, data: [cooking], meta: { total: 1, shown: 1, notShown: 0, cap: 300 } } };
    renderWithQuery(<OrdersPage />);
    await screen.findByRole('region', { name: 'Preparing orders' });
    await waitFor(() => expect(screen.getAllByText('#SW-OLD1')).toHaveLength(1));
  });
});
