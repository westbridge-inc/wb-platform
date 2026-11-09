import { beforeEach, describe, expect, it, vi } from 'vitest';

// [STORE-ALERT-RECONNECT] The native events become the app-wide signals the live layers act on.
const fx = vi.hoisted(() => ({
  appState: null as null | ((state: string) => void),
  received: null as null | ((n: unknown) => void),
  removed: [] as string[],
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: (_: string, cb: (s: string) => void) => { fx.appState = cb; return { remove: () => fx.removed.push('appState') }; } },
}));
vi.mock('expo-notifications', () => ({
  addNotificationReceivedListener: (cb: (n: unknown) => void) => { fx.received = cb; return { remove: () => fx.removed.push('received') }; },
}));

import { installAppSignals } from './appSignals';
import { onAppForeground, onForegroundPush } from '../lib/appSignals';

beforeEach(() => { fx.removed = []; });

describe('installAppSignals', () => {
  it('"active" is the foreground signal; a received push carries its data; installed once; removable', () => {
    const stop = installAppSignals();
    expect(installAppSignals()).toBeTypeOf('function'); // a second install is a no-op
    const foreground = vi.fn();
    const pushes: unknown[] = [];
    const offA = onAppForeground(foreground);
    const offB = onForegroundPush((d) => pushes.push(d));
    fx.appState!('background');
    fx.appState!('active');
    fx.received!({ request: { content: { data: { kind: 'vendor_order_alert', orderId: 'o1' } } } });
    fx.received!({ request: { content: { data: null } } });
    expect(foreground).toHaveBeenCalledTimes(1);
    expect(pushes).toEqual([{ kind: 'vendor_order_alert', orderId: 'o1' }]);
    offA(); offB();
    stop();
    expect(fx.removed.sort()).toEqual(['appState', 'received']);
  });

  it('one listener that throws never stops the others', () => {
    const stop = installAppSignals();
    const after = vi.fn();
    const offA = onAppForeground(() => { throw new Error('boom'); });
    const offB = onAppForeground(after);
    fx.appState!('active');
    expect(after).toHaveBeenCalledTimes(1);
    offA(); offB(); stop();
  });
});
