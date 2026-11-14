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

const REASON = 'The manager checked the Dragontail screen';
const on = { switchOn: true, connected: true, enabled: true, mode: 'AUTO_DRIVER_CHECK', busyHours: [], updatedAt: null, driverCheckAvailable: true };

describe('[DT-OVERFLOW] the console panel', () => {
  it('shows nothing while the switch is off', async () => {
    const fetchMock = serve({ ...on, switchOn: false });
    const { container } = renderWithQuery(<KitchenOverflowPanel vendorId="vendor-dt" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows the setting and where recent deliveries went, and saves with a stated reason (PDF v1.1 §6)', async () => {
    const writes: ApiRequest[] = [];
    serve(on, writes);
    const { user } = renderWithQuery(<KitchenOverflowPanel vendorId="vendor-dt" />);
    expect(await screen.findByText(/SW-2001: Swift riders \(no free driver\)/)).toBeTruthy();
    expect(screen.getByText(/SW-2002: Dragontail \(driver check failed or timed out \(safe default\)\)/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(writes, 'nothing is sent before a reason').toHaveLength(0);
    await user.type(await screen.findByRole('textbox'), REASON);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ mode: 'AUTO_DRIVER_CHECK' });
    expect(new Headers(writes[0]!.init?.headers).get('x-swift-reason')).toBe(REASON);
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
    await user.type(await screen.findByRole('textbox'), REASON);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ mode: 'NONE' });
  });

  it('[round 3] orders Dragontail may also have are listed; "Dragontail does not have it" clears one', async () => {
    const writes: ApiRequest[] = [];
    mockApi((r) => {
      if (r.method === 'GET' && r.url.pathname === `${PATH}/overflow`) {
        return { body: { success: true, data: { ...on, maybeInKitchen: [{ orderId: 'o9', orderNumber: 'SW-2009', orderStatus: 'ACCEPTED', fallbackAt: '2026-11-14T22:10:00.000Z' }] } } };
      }
      if (r.method === 'GET' && r.url.pathname === `${PATH}/routes`) {
        return { body: { success: true, data: [{ id: 'o8', orderNumber: 'SW-2008', status: 'PENDING', kitchenRoute: 'TABLET', kitchenRouteReason: 'LINK_OFFLINE', kitchenRouteAt: null, fulfillmentMode: null, riderId: null }] } };
      }
      if (r.method === 'POST' && r.url.pathname === `${PATH}/orders/o9/not-in-kitchen`) { writes.push(r); return { body: { success: true, data: { orderId: 'o9', maybeInKitchen: false } } }; }
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<KitchenOverflowPanel vendorId="vendor-dt" />);
    expect(await screen.findByText(/SW-2008: tablet, own driver \(kitchen link offline/)).toBeTruthy();
    expect(screen.getByText(/SW-2009/)).toBeTruthy();
    // [follow-up · N-5] A confirm and a reason first: nothing is sent on the first click.
    await user.click(screen.getByRole('button', { name: 'Dragontail does not have it' }));
    expect(await screen.findByText(/Dragontail does not have order SW-2009\?/)).toBeTruthy();
    expect(writes).toHaveLength(0);
    await user.type(screen.getByRole('textbox'), REASON);
    const buttons = screen.getAllByRole('button', { name: 'Dragontail does not have it' });
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(new Headers(writes[0]!.init?.headers).get('x-swift-reason')).toBe(REASON);
  });

  it('[follow-up · N-2] with the switch OFF (the only time such orders are flagged), the list and its clear action still show', async () => {
    const writes: ApiRequest[] = [];
    mockApi((r) => {
      if (r.method === 'GET' && r.url.pathname === `${PATH}/overflow`) {
        return { body: { success: true, data: { ...on, switchOn: false, maybeInKitchen: [{ orderId: 'o9', orderNumber: 'SW-2009', orderStatus: 'PENDING', fallbackAt: null }] } } };
      }
      if (r.method === 'POST' && r.url.pathname === `${PATH}/orders/o9/not-in-kitchen`) { writes.push(r); return { body: { success: true, data: { orderId: 'o9', maybeInKitchen: false } } }; }
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<KitchenOverflowPanel vendorId="vendor-dt" />);
    expect(await screen.findByText(/SW-2009/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' }), 'the overflow setting itself stays hidden').toBeNull();
    await user.click(screen.getByRole('button', { name: 'Dragontail does not have it' }));
    await user.type(await screen.findByRole('textbox'), REASON);
    const buttons = screen.getAllByRole('button', { name: 'Dragontail does not have it' });
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(writes).toHaveLength(1));
  });

  it('[follow-up · N-1] an offline link offers "Try the link now", with a reason', async () => {
    const writes: ApiRequest[] = [];
    mockApi((r) => {
      if (r.method === 'GET' && r.url.pathname === `${PATH}/overflow`) return { body: { success: true, data: { ...on, linkOfflineAt: '2026-11-14T22:00:00.000Z' } } };
      if (r.method === 'GET' && r.url.pathname === `${PATH}/routes`) return { body: { success: true, data: [] } };
      if (r.method === 'POST' && r.url.pathname === `${PATH}/link/try`) { writes.push(r); return { body: { success: true, data: { result: 'login-only', linkOffline: false, problem: null } } }; }
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<KitchenOverflowPanel vendorId="vendor-dt" />);
    expect(await screen.findByText(/Kitchen link offline, orders on tablet/)).toBeTruthy();
    expect(screen.queryByText(/every minute/), 'no promise the back-off breaks').toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try the link now' }));
    await user.type(await screen.findByRole('textbox'), REASON);
    const buttons = screen.getAllByRole('button', { name: 'Try the link now' });
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(new Headers(writes[0]!.init?.headers).get('x-swift-reason')).toBe(REASON);
  });
});

