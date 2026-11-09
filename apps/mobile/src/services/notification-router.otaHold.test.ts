import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [OTA-CATCH-UP · REVIEW-2 S3-1 on #2431] A tapped notification is never handed to the next JavaScript after a
// restart (expo-notifications keeps the last response per module instance), so the catch-up waits while a tap is
// still landing: one in the last few seconds, one queued for navigation, one held for the sign-in it opened.
const fx = vi.hoisted(() => ({
  owner: { userId: 'synthetic-owner', generation: 1 } as { userId: string; generation: number } | null,
  ready: true,
  listener: undefined as undefined | ((response: unknown) => void),
}));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof fx.listener) => { fx.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: async () => null,
}));
vi.mock('../navigation/navigationRef', () => ({ navigationRef: { isReady: () => fx.ready }, safeNavigate: () => true }));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => (fx.owner ? { ...fx.owner } : null),
  getLastSignedOutUserId: () => 'synthetic-owner',
  useAuthStore: { getState: () => ({ intent: 'customer', promptLogin: vi.fn() }) },
}));
vi.mock('../services/socket', () => ({ disconnectSocket: vi.fn(), reconnectSocketForStoreHandoff: vi.fn() }));
vi.mock('../services/api', () => ({ vendorApi: {} }));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
import { TAP_SETTLE_MS, installNotificationTapRouter, tapRoutingBusy } from './notification-router';

let uninstall: () => void;
const tap = (data: Record<string, unknown>) => fx.listener!({ notification: { request: { identifier: 'n1', content: { data } } }, actionIdentifier: 'default' });
const message = { kind: 'chat_message', orderId: 'order-1' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  fx.owner = { userId: 'synthetic-owner', generation: 1 };
  fx.ready = true;
  uninstall = installNotificationTapRouter();
});
afterEach(() => { uninstall(); vi.useRealTimers(); });

describe('[OTA-CATCH-UP] a notification tap still landing', () => {
  it('no tap: not busy; a tap: busy for TAP_SETTLE_MS, then not', () => {
    expect(tapRoutingBusy()).toBe(false);
    tap(message);
    expect(tapRoutingBusy()).toBe(true);
    vi.advanceTimersByTime(TAP_SETTLE_MS - 1);
    expect(tapRoutingBusy()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tapRoutingBusy()).toBe(false);
  });

  it('a tap queued until navigation is ready stays busy however long it waits', async () => {
    fx.ready = false;
    tap(message);
    await Promise.resolve();
    vi.advanceTimersByTime(TAP_SETTLE_MS * 3);
    expect(tapRoutingBusy()).toBe(true);
  });

  it('a tap held for the sign-in it opened stays busy', () => {
    fx.owner = null;
    tap(message);
    vi.advanceTimersByTime(TAP_SETTLE_MS * 3);
    expect(tapRoutingBusy()).toBe(true);
  });

  it('uninstalled: nothing held', () => {
    tap(message);
    uninstall();
    expect(tapRoutingBusy()).toBe(false);
    uninstall = installNotificationTapRouter();
  });
});
