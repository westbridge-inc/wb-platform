import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrdersPage from './page';
import { setSelectedStore } from '@/lib/auth';
import { mockApi, renderWithQuery, stubAudioContext, withOpenBoard } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';

// [STORE-BOARD · parity audit C4] The Orders page (the live board) keeps a counter tablet's screen on while it is open.
describe('[STORE-BOARD C4] the Orders page holds the screen on', () => {
  const request = vi.fn(async () => ({ released: false, release: vi.fn(async () => {}) }));
  beforeEach(() => {
    stubAudioContext();
    setSelectedStore('store-1');
    request.mockClear();
    vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } });
    mockApi(withOpenBoard(({ url }) => (url.pathname === '/api/v1/vendor/orders'
      ? { body: { success: true, data: [wireVendorOrder({ status: 'PREPARING' })], meta: { total: 1 } } }
      : { status: 404, body: { success: false } })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks for the screen lock when the board opens', async () => {
    const view = renderWithQuery(<OrdersPage />);
    await screen.findByRole('region', { name: 'Preparing orders' });
    await act(async () => {});
    expect(request).toHaveBeenCalledWith('screen');
    view.unmount();
  });
});
