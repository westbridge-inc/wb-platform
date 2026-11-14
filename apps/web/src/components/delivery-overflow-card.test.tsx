import { screen } from '@testing-library/react';
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
    expect(screen.getByRole('radio', { name: /During my busy hours/ })).toHaveProperty('checked', true);
    expect((screen.getByLabelText('Busy hours 1: from') as HTMLInputElement).value).toBe('22:00');
  });
});
