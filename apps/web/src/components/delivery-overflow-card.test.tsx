import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeliveryOverflowCard } from './delivery-overflow-card';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// [DT-OVERFLOW · DT-OUTAGE] The Dragontail branch's card: nothing for any other store; the setting; and, while the
// branch's kitchen link is down, "Kitchen link offline, orders on tablet".

function serve(data: Record<string, unknown>) {
  return mockApi((r: ApiRequest) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/vendor/kitchen-overflow') return { body: { success: true, data } };
    throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
  });
}

describe('[DT-OVERFLOW] the branch card', () => {
  it('a store with no Dragontail connection sees nothing', async () => {
    const fetchMock = serve({ available: false, mode: 'NONE', busyHours: [], linkOffline: false });
    const { container } = renderWithQuery(<DeliveryOverflowCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('a connected branch sees its choices; while the link is down it says so first', async () => {
    serve({ available: true, mode: 'BUSY_HOURS', busyHours: [{ day: 5, start: '22:00', end: '02:00' }], linkOffline: true });
    renderWithQuery(<DeliveryOverflowCard />);
    expect(await screen.findByText('Kitchen link offline, orders on tablet')).toBeTruthy();
    // The saved setting fills the form once it has been read (an effect after the first draw).
    await waitFor(() => expect(screen.getByRole('radio', { name: /During my busy hours/ })).toHaveProperty('checked', true));
    expect((screen.getByLabelText('Busy hours 1: from') as HTMLInputElement).value).toBe('22:00');
  });

  it('[round 2] the two choices that ask Dragontail for a free driver are greyed until the server turns the check on', async () => {
    serve({ available: true, mode: 'NONE', busyHours: [], linkOffline: false, driverCheckAvailable: false });
    renderWithQuery(<DeliveryOverflowCard />);
    const auto = await screen.findByRole('radio', { name: /When all my drivers are busy/ });
    expect(auto).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /^Both/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /During my busy hours/ })).toHaveProperty('disabled', false);
    expect(screen.getAllByText(/waiting for Dragontail to confirm its driver check/)).toHaveLength(2);
  });

  it('[round 2] once the server turns the check on, they can be chosen', async () => {
    serve({ available: true, mode: 'NONE', busyHours: [], linkOffline: false, driverCheckAvailable: true });
    renderWithQuery(<DeliveryOverflowCard />);
    expect(await screen.findByRole('radio', { name: /When all my drivers are busy/ })).toHaveProperty('disabled', false);
  });
});
