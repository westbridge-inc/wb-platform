import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

// [APP-PREPTIME · owner 14 Nov 2026] The store app's Accept sends the chosen preparation time the way the website does:
// PUT /vendor/orders/:id/accept with { estimatedPrepTime } (the API's acceptOrderSchema field). No minutes (a booking): no
// body, the request it always was.

const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return { previousApiUrl };
});

const auth = vi.hoisted(() => ({
  current: null as AuthSessionSnapshot | null,
  selectedStoreId: null as string | null,
}));

vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => auth.current,
  isAuthSessionSnapshotCurrent: () => false,
  useAuthStore: { getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }) },
}));
vi.mock('../stores/storeSwitcher', () => ({
  useStoreSwitcher: { getState: () => ({ selectedStoreId: auth.selectedStoreId }) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));

import { api, vendorApi } from './api';

const originalApiAdapter = api.defaults.adapter;

function ok(config: InternalAxiosRequestConfig): AxiosResponse {
  return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: { id: 'o1', status: 'PREPARING' } } };
}

afterEach(() => {
  api.defaults.adapter = originalApiAdapter;
  auth.current = null;
  auth.selectedStoreId = null;
});

afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

async function sent(call: () => Promise<unknown>) {
  auth.current = { generation: 1, userId: 'staff-a', accessToken: 'access-a', refreshToken: 'refresh-a' };
  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => { seen.push(config); return ok(config); };
  api.defaults.adapter = adapter;
  await call();
  expect(seen).toHaveLength(1);
  const raw = seen[0]!.data;
  return { method: seen[0]!.method, url: seen[0]!.url, body: typeof raw === 'string' && raw ? JSON.parse(raw) : raw };
}

describe('[APP-PREPTIME] Accept carries the preparation time', () => {
  it('the chosen minutes ride as estimatedPrepTime on PUT /vendor/orders/:id/accept', async () => {
    expect(await sent(() => vendorApi.acceptOrder('o1', 45))).toEqual({ method: 'put', url: '/vendor/orders/o1/accept', body: { estimatedPrepTime: 45 } });
  });

  it('the default 20 is sent as 20', async () => {
    expect((await sent(() => vendorApi.acceptOrder('o1', 20))).body).toEqual({ estimatedPrepTime: 20 });
  });

  it('no minutes (a booking): no estimatedPrepTime at all', async () => {
    const { body } = await sent(() => vendorApi.acceptOrder('o1'));
    expect(body ?? {}).toEqual({});
  });
});
