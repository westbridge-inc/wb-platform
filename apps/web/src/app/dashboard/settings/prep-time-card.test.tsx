import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PrepTimeCard } from './prep-time-card';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [STORE-PREP · parity audit C3, owner ruling 14 Nov 2026] The store's usual preparation time (Vendor.estimatedPrepTime)
// is set by the owner or a manager in Settings. Accept pre-selects it on every new order (the order carries it from
// checkout). The server already takes it on PUT /vendor/profile; no screen could set it, so every store sat at 30.
// ---------------------------------------------------------------------------

let store: Record<string, unknown>;
let role: string;
let writes: ApiRequest[];

beforeEach(async () => {
  store = { id: 'store-1', vendorType: 'RESTAURANT', estimatedPrepTime: 30 };
  role = 'OWNER';
  writes = [];
  (await import('@/lib/auth')).setSelectedStore('store-1');
  mockApi((r) => {
    if (r.url.pathname === '/api/v1/vendor/profile' && r.method === 'GET') return { body: { success: true, data: { myRole: role, vendors: [store] } } };
    if (r.url.pathname === '/api/v1/vendor/profile' && r.method === 'PUT') {
      writes.push(r);
      store = { ...store, ...JSON.parse(String(r.init?.body)) };
      return { body: { success: true, data: store } };
    }
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
});

const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };

describe('[STORE-PREP] usual preparation time', () => {
  it('shows the stored time chosen; picking 45 and Save sends estimatedPrepTime 45', async () => {
    renderWithQuery(<PrepTimeCard storeId="store-1" />);
    expect(await screen.findByRole('heading', { name: 'Usual preparation time' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '30 min' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Accept starts at 30 min on every new order. Staff can still pick another time on each order.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await click('45 min');
    await click('Save');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ estimatedPrepTime: 45 });
    await waitFor(() => expect(screen.getByText('Accept starts at 45 min on every new order. Staff can still pick another time on each order.')).toBeTruthy());
  });

  it('a stored time that is not one of the choices: says Accept starts at the closest one', async () => {
    store = { ...store, estimatedPrepTime: 35 };
    renderWithQuery(<PrepTimeCard storeId="store-1" />);
    expect(await screen.findByText('Now 35 min: Accept starts at the closest choice, 30 min. Pick your usual time.')).toBeTruthy();
  });

  it('a shop says "ready time"', async () => {
    store = { ...store, vendorType: 'SUPERMARKET' };
    renderWithQuery(<PrepTimeCard storeId="store-1" />);
    expect(await screen.findByRole('heading', { name: 'Usual ready time' })).toBeTruthy();
  });

  it('staff do not get the card; nor does a Services business (bookings have no preparation time)', async () => {
    role = 'STAFF';
    const staff = renderWithQuery(<PrepTimeCard storeId="store-1" />);
    await waitFor(() => expect(writes).toHaveLength(0));
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: /Usual/ })).toBeNull();
    staff.unmount();
    role = 'MANAGER';
    store = { ...store, vendorType: 'SERVICE' };
    renderWithQuery(<PrepTimeCard storeId="store-1" />);
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: /Usual/ })).toBeNull();
  });

  it('a manager gets it; a refusal shows the server\'s words', async () => {
    role = 'MANAGER';
    mockApi((r) => {
      if (r.method === 'GET') return { body: { success: true, data: { myRole: role, vendors: [store] } } };
      return { status: 403, body: { success: false, error: { code: 'STAFF_FORBIDDEN', message: 'This needs a manager' } } };
    });
    renderWithQuery(<PrepTimeCard storeId="store-1" />);
    await screen.findByRole('heading', { name: 'Usual preparation time' });
    await click('20 min');
    await click('Save');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
