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

import { api, vendorApi } from './api';
import { VENDOR_STORE_HEADER } from '../lib/vendorScope';

// ---------------------------------------------------------------------------
// [REVIEW-MENU-B S3-5 · S2-1] The store tools' option writes say this app edits sizes, halves and follow-up groups
// (MENU_OPTIONS_V2): the server refuses an older store app's edit of such a group, since that app would read a size's
// price as an add-on ("+200" typed for an extra large makes a $200 pizza). A size switch carries every choice's new price
// in the same request. Synthetic ids only.
// ---------------------------------------------------------------------------

const originalApiAdapter = api.defaults.adapter;
afterEach(() => { api.defaults.adapter = originalApiAdapter; });
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

function capture(): Array<[string | undefined, string | undefined, unknown]> {
  const seen: Array<[string | undefined, string | undefined, unknown]> = [];
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    seen.push([config.method, config.url, typeof config.data === 'string' ? JSON.parse(config.data) : config.data]);
    return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: {} } } as AxiosResponse;
  };
  api.defaults.adapter = adapter;
  return seen;
}

const CAP = ['MENU_OPTIONS_V2'];

describe('[REVIEW-MENU-B S3-5] the store tools\' option writes declare MENU_OPTIONS_V2', () => {
  it('a new group (with its first size), a rule change with its converted prices, a new choice and a choice edit', async () => {
    const seen = capture();
    await vendorApi.addOptionGroup('item-1', { name: 'Size', setsPrice: true, isRequired: true, minSelect: 1, maxSelect: 1, options: [{ name: 'Small', additionalPrice: 2000 }] });
    await vendorApi.updateOptionGroup('g-1', { setsPrice: true, prices: [{ id: 'o-s', price: 2000 }, { id: 'o-l', price: 2500 }] });
    await vendorApi.addOption('g-1', { name: 'Large', additionalPrice: 2500 });
    await vendorApi.updateOption('o-1', { followUpGroupId: 'g-2' });
    expect(seen).toEqual([
      ['post', '/vendor/items/item-1/option-groups', { name: 'Size', setsPrice: true, isRequired: true, minSelect: 1, maxSelect: 1, options: [{ name: 'Small', additionalPrice: 2000 }], capabilities: CAP }],
      ['put', '/vendor/option-groups/g-1', { setsPrice: true, prices: [{ id: 'o-s', price: 2000 }, { id: 'o-l', price: 2500 }], capabilities: CAP }],
      ['post', '/vendor/option-groups/g-1/options', { name: 'Large', additionalPrice: 2500, capabilities: CAP }],
      ['put', '/vendor/options/o-1', { followUpGroupId: 'g-2', capabilities: CAP }],
    ]);
  });

  it('a shared group\'s size switch sends its prices with it', async () => {
    const seen = capture();
    await vendorApi.updateModifierGroup('lib-1', { setsPrice: true, prices: [{ id: 'lo-1', price: 2200 }] });
    expect(seen).toEqual([['put', '/vendor/modifier-groups/lib-1', { setsPrice: true, prices: [{ id: 'lo-1', price: 2200 }], capabilities: CAP }]]);
  });

  it('every library write declares it too', async () => {
    const seen = capture();
    await vendorApi.createModifierGroup({ name: 'Crust' });
    await vendorApi.orderModifierGroups(['a', 'b']);
    await vendorApi.addModifierOption('lib-1', { name: 'Thin', price: 0 });
    await vendorApi.orderModifierOptions('lib-1', ['x']);
    await vendorApi.updateModifierOption('lo-1', { isAvailable: false });
    await vendorApi.attachModifierGroup('lib-1', ['i-1']);
    await vendorApi.detachModifierGroup('lib-1', ['i-2']);
    expect(seen).toEqual([
      ['post', '/vendor/modifier-groups', { name: 'Crust', capabilities: CAP }],
      ['put', '/vendor/modifier-groups/order', { ids: ['a', 'b'], capabilities: CAP }],
      ['post', '/vendor/modifier-groups/lib-1/options', { name: 'Thin', price: 0, capabilities: CAP }],
      ['put', '/vendor/modifier-groups/lib-1/options/order', { ids: ['x'], capabilities: CAP }],
      ['put', '/vendor/modifier-options/lo-1', { isAvailable: false, capabilities: CAP }],
      ['post', '/vendor/modifier-groups/lib-1/attach', { itemIds: ['i-1'], capabilities: CAP }],
      ['post', '/vendor/modifier-groups/lib-1/detach', { itemIds: ['i-2'], capabilities: CAP }],
    ]);
  });
});

// [REVIEW-MENU-A S4-11] A library call names the store the screen was showing (x-vendor-id), never whichever store
// happens to be selected when the request leaves.
describe('[REVIEW-MENU-A S4-11] the option library names its store', () => {
  it('reads and writes carry the store they were made for', async () => {
    const headers: Array<string | undefined> = [];
    api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      headers.push(String(config.headers?.get?.(VENDOR_STORE_HEADER) ?? config.headers?.[VENDOR_STORE_HEADER] ?? ''));
      return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: {} } } as AxiosResponse;
    }) as AxiosAdapter;
    await vendorApi.modifierGroups(undefined, 'store-A');
    await vendorApi.updateModifierGroup('lib-1', { name: 'Crust' }, undefined, 'store-A');
    await vendorApi.deleteModifierOption('lo-1', undefined, 'store-A');
    await vendorApi.attachModifierGroup('lib-1', ['i-1'], undefined, 'store-A');
    expect(headers).toEqual(['store-A', 'store-A', 'store-A', 'store-A']);
  });
});
