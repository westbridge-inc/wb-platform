import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [STORE-BOARD S1 · parity audit 14 Nov 2026, B1] The website rang for a new order on the Orders page only: the
// takeover, its chime and the flashing tab title were mounted by that page, so a store working on Menu, Settings,
// Insights or Team heard nothing. The ring now belongs to the dashboard shell (every page), mounted once: the
// Orders page no longer mounts its own, so it never rings twice. The ring's one door into an order ("Paid by MMG",
// which the order window confirms) opens that order on the Orders page, from any page.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ getStores: vi.fn(), push: vi.fn(), pathname: '/dashboard/settings' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: fx.push }), usePathname: () => fx.pathname }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return { ...real, sessionProbe: vi.fn().mockResolvedValue({ ok: true, user: { id: 'u1' } }), setSelectedStore: vi.fn() };
});
vi.mock('@/lib/vendor-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/vendor-api')>();
  return { ...real, getStores: fx.getStores };
});

import { DashboardShell } from './dashboard-shell';
import OrdersPage from './orders/page';

const later = () => new Date(Date.now() + 5 * 60_000).toISOString();
/** An MMG order the store says was paid by a wallet message: the ring's "Paid by MMG" opens the order window. */
const mmgToConfirm = () => wireVendorOrder({ id: 'o-mmg', orderNumber: 'SW-MMG1', status: 'PENDING', respondBy: later(), paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', mmgAttestedRef: 'REF1', canConfirmPayment: true });
let board: unknown[] = [];
/** The paths fetched so far (the stubbed fetch's calls). */
const mockApiCalls = () => () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([input]) => new URL(String(input)).pathname);

beforeEach(() => {
  stubAudioContext();
  fx.push.mockReset();
  fx.getStores.mockReset();
  fx.getStores.mockResolvedValue({ stores: [{ id: 'north', name: 'Royal North', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true, status: 'ACTIVE' }], selectedId: 'north', myRole: 'OWNER' });
  window.localStorage.setItem('swift_web_store', 'north');
  board = [wireVendorOrder({ id: 'o-new', orderNumber: 'SW-RING1', status: 'PENDING', respondBy: later() })];
  mockApi((request: ApiRequest) => {
    const path = request.url.pathname.replace('/api/v1', '');
    if (request.method !== 'GET') return { body: { success: true, data: {} } };
    if (path === '/vendor/orders/open') return { body: { success: true, data: board, meta: { total: board.length, shown: board.length, notShown: 0, cap: 300 } } };
    if (path === '/vendor/orders') return { body: { success: true, data: board, meta: { total: board.length } } };
    if (path.startsWith('/vendor/orders/')) return { body: { success: true, data: board[0] } };
    return { status: 404, body: { success: false } };
  });
});

// The first test of a run pays for transforming the shell, the board and the ring's chunk.
vi.setConfig({ testTimeout: 20_000 });

describe('[STORE-BOARD S1] the new-order ring on every dashboard page', () => {
  it('on Settings (not the Orders page) a new order takes the screen', async () => {
    fx.pathname = '/dashboard/settings';
    render(<DashboardShell><p>Settings page</p></DashboardShell>);
    const ring = await screen.findByRole('alertdialog', {}, { timeout: 10_000 });
    expect(within(ring).getByText(/NEW ORDER/)).toBeTruthy();
    expect(within(ring).getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('on the Orders page it rings once (one takeover, not two)', async () => {
    fx.pathname = '/dashboard/orders';
    render(<DashboardShell><OrdersPage /></DashboardShell>);
    await screen.findByRole('alertdialog', {}, { timeout: 10_000 });
    // The board itself has drawn (its lanes), and still one takeover.
    await screen.findByRole('region', { name: 'New orders' }, { timeout: 10_000 });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('"Paid by MMG" on another page goes to the Orders page, which opens that order', async () => {
    fx.pathname = '/dashboard/settings';
    board = [mmgToConfirm()];
    const user = userEvent.setup();
    const view = render(<DashboardShell><p>Settings page</p></DashboardShell>);
    const ring = await screen.findByRole('alertdialog', {}, { timeout: 10_000 });
    await user.click(within(ring).getByRole('button', { name: 'Paid by MMG' }));
    expect(fx.push).toHaveBeenCalledWith('/dashboard/orders');
    // The Orders page then mounts and opens the order the ring asked for.
    fx.pathname = '/dashboard/orders';
    view.rerender(<DashboardShell><OrdersPage /></DashboardShell>);
    expect(await screen.findByRole('dialog', { name: 'Order details' })).toBeTruthy();
  });

  it('"Paid by MMG" on the Orders page opens the order window there (no navigation)', async () => {
    fx.pathname = '/dashboard/orders';
    board = [mmgToConfirm()];
    const user = userEvent.setup();
    render(<DashboardShell><OrdersPage /></DashboardShell>);
    const ring = await screen.findByRole('alertdialog', {}, { timeout: 10_000 });
    await user.click(within(ring).getByRole('button', { name: 'Paid by MMG' }));
    expect(await screen.findByRole('dialog', { name: 'Order details' })).toBeTruthy();
    expect(fx.push).not.toHaveBeenCalled();
  });

  it('control: nothing waiting, no ring', async () => {
    board = [wireVendorOrder({ id: 'o-cook', orderNumber: 'SW-COOK', status: 'PREPARING' })];
    const fetched = mockApiCalls();
    render(<DashboardShell><p>Settings page</p></DashboardShell>);
    await screen.findAllByText('Royal North');
    // The ring has read the board (so it is mounted and listening), and stays down.
    await waitFor(() => expect(fetched().some((p) => p === '/api/v1/vendor/orders/open')).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
