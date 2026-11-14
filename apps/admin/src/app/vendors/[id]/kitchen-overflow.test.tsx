import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KitchenOverflowPanel } from './kitchen-overflow';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [DT-OVERFLOW · owner 14 Nov 2026] A Dragontail branch's overflow on its console page: nothing while the switch is off
// or the branch is not connected; otherwise the setting, saved without a reason (an operational change), and where its
// recent deliveries went and why. Synthetic store only.
// ---------------------------------------------------------------------------

const PATH = '/api/v1/admin/vendors/vendor-dt/kitchen-integration';

function serve(setting: Record<string, unknown>, writes: ApiRequest[] = []) {
  return mockApi((r) => {
    if (r.method === 'GET' && r.url.pathname === `${PATH}/overflow`) return { body: { success: true, data: setting } };
    if (r.method === 'GET' && r.url.pathname === `${PATH}/routes`) {
      return { body: { success: true, data: [
        { id: 'o1', orderNumber: 'SW-2001', status: 'ACCEPTED', kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'NO_FREE_DRIVER', kitchenRouteAt: '2026-11-14T22:00:00.000Z', fulfillmentMode: 'PLATFORM_RIDER', riderId: null },
        { id: 'o2', orderNumber: 'SW-2002', status: 'PREPARING', kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_CHECK_FAILED', kitchenRouteAt: '2026-11-14T22:05:00.000Z', fulfillmentMode: 'VENDOR_DELIVERY', riderId: null },
      ] } };
    }
    if (r.method === 'PUT' && r.url.pathname === `${PATH}/overflow`) { writes.push(r); return { body: { success: true, data: setting } }; }
    throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
  });
}

const on = { switchOn: true, connected: true, enabled: true, mode: 'AUTO_DRIVER_CHECK', busyHours: [], updatedAt: null, driverCheckAvailable: true };

describe('[DT-OVERFLOW] the console panel', () => {
  it('shows nothing while the switch is off', async () => {
    const fetchMock = serve({ ...on, switchOn: false });
    const { container } = renderWithQuery(<KitchenOverflowPanel vendorId="vendor-dt" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows the setting and where recent deliveries went, and saves without a reason', async () => {
    const writes: ApiRequest[] = [];
    serve(on, writes);
    const { user } = renderWithQuery(<KitchenOverflowPanel vendorId="vendor-dt" />);
    expect(await screen.findByText(/SW-2001: Swift riders \(no free driver\)/)).toBeTruthy();
    expect(screen.getByText(/SW-2002: Dragontail \(driver check failed or timed out \(safe default\)\)/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ mode: 'AUTO_DRIVER_CHECK' });
  });

  it('[round 2] while the driver check waits for Dragontail: its two choices are greyed, and a branch still set to one cannot be saved as is', async () => {
    const writes: ApiRequest[] = [];
    serve({ ...on, driverCheckAvailable: false, driverCheck: null }, writes);
    const { user } = renderWithQuery(<KitchenOverflowPanel vendorId="vendor-dt" />);
    await screen.findByText(/SW-2001/);
    const auto = screen.getByRole('option', { name: /When all its drivers are busy/ }) as HTMLOptionElement;
    const both = screen.getByRole('option', { name: /Busy hours, then/ }) as HTMLOptionElement;
    expect(auto.disabled).toBe(true);
    expect(auto.textContent).toContain('waiting for Dragontail');
    expect(both.disabled).toBe(true);
    expect((screen.getByRole('option', { name: /During its busy hours/ }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByRole('combobox'), 'NONE');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ mode: 'NONE' });
  });
});
