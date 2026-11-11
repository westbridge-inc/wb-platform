import { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return { previousApiUrl };
});

vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => null,
  isAuthSessionSnapshotCurrent: () => false,
  useAuthStore: { getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }) },
}));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));

import { api, customerApi } from './api';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] Every cart write says this app shows sizes that set the price, halves and
// follow-up choices. Without the word the server refuses such an item (409 APP_UPDATE_REQUIRED, "update the app")
// even though this app shows it right. Synthetic ids only.
// ---------------------------------------------------------------------------

const originalApiAdapter = api.defaults.adapter;
afterEach(() => { api.defaults.adapter = originalApiAdapter; });
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

function capture(): Array<{ url?: string; method?: string; body: unknown }> {
  const seen: Array<{ url?: string; method?: string; body: unknown }> = [];
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    seen.push({ url: config.url, method: config.method, body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data });
    return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: { cart: null } } } as AxiosResponse;
  };
  api.defaults.adapter = adapter;
  return seen;
}

describe('[MENU-OPTIONS] the cart writes declare MENU_OPTIONS_V2', () => {
  it('an add sends the choices as the API reads them, and the capability', async () => {
    const seen = capture();
    await customerApi.addToCart({ vendorId: 'store-1', itemId: 'pizza-1', quantity: 2, selectedOptions: { size: 'large', toppings: ['pep:left', 'mush:right'] } });
    expect(seen).toEqual([{ url: '/customer/cart/items', method: 'post', body: {
      vendorId: 'store-1', itemId: 'pizza-1', quantity: 2, selectedOptions: { size: 'large', toppings: ['pep:left', 'mush:right'] }, capabilities: ['MENU_OPTIONS_V2'],
    } }]);
  });

  it('a line change (a + or −, or new choices) sends it too', async () => {
    const seen = capture();
    await customerApi.updateCartItem('line-1', { quantity: 3 });
    await customerApi.updateCartItem('line-1', { quantity: 1, selectedOptions: { size: 'medium' } });
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['put', '/customer/cart/items/line-1', { quantity: 3, capabilities: ['MENU_OPTIONS_V2'] }],
      ['put', '/customer/cart/items/line-1', { quantity: 1, selectedOptions: { size: 'medium' }, capabilities: ['MENU_OPTIONS_V2'] }],
    ]);
  });
});
