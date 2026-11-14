/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-PREPTIME · owner 14 Nov 2026] The full-screen new-order alert on the
// store's tablet: staff accept with a preparation time, like the website's
// takeover. 20 is pre-selected so a busy kitchen still accepts in ONE tap;
// another time is one more tap; the last choice is remembered for the store
// on this device. A booking is never asked and sends no minutes.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  order: null as any,
  mutate: vi.fn(),
  disk: new Map<string, string>(),
}));

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', { role: p.accessibilityRole, 'aria-label': p.accessibilityLabel }, p.children);
  const Press = (p: any) => h('button', { role: p.accessibilityRole, 'aria-checked': p.accessibilityState?.checked ? 'true' : 'false', disabled: p.disabled, onClick: p.onPress }, p.children);
  return { View: Box, ScrollView: Box, Modal: Box, Pressable: Press };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-reanimated', async () => {
  const { createElement: h } = await import('react');
  return {
    default: { View: (p: any) => h('div', null, p.children) },
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: () => ({}),
    useSharedValue: (v: unknown) => ({ value: v }),
    withSequence: () => 1,
    withTiming: () => 1,
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('../../kit', async () => {
  const { createElement: h } = await import('react');
  const Text = (p: any) => h('span', { onClick: p.onPress }, p.children);
  return {
    T: Text,
    Money: () => null,
    PillButton: (p: any) => h('button', { disabled: p.disabled || p.loading, onClick: p.onPress }, p.label),
  };
});
vi.mock('../../lib/haptics', () => ({ haptic: { commit: vi.fn(), select: vi.fn() } }));
vi.mock('../../hooks/vendorops', () => ({
  useVendorOrder: () => ({ data: fx.order }),
  useOrderAction: () => ({ mutate: fx.mutate, isPending: false, isError: false }),
  usePickingActions: () => ({ refundLine: { mutate: vi.fn(), isPending: false } }),
  useVendorProfile: () => ({ store: { id: 'store-a', vendorType: 'RESTAURANT' } }),
}));
vi.mock('../../hooks/useJobRing', () => ({ useJobRing: vi.fn() }));
vi.mock('../../services/jobRinger', () => ({ RING_PERIOD_MS: 2000 }));
vi.mock('../../services/jobRingCapability', () => ({ hasJobRing: () => true }));

import { NewOrderTakeover } from './NewOrderTakeover';
import { bindPrepTimeStorage } from './prepTimeMemory';

const pending = (id: string, extra: Record<string, unknown> = {}) => ({
  id, orderNumber: `SW-${id}`, status: 'PENDING', vendorId: 'store-a', fulfillment: 'DELIVERY',
  vendor: { vendorType: 'RESTAURANT' }, items: [{ id: `${id}-l1`, name: 'Cook-up', quantity: 1, subStatus: null }],
  ...extra,
});

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  fx.mutate.mockReset();
  fx.disk.clear();
  bindPrepTimeStorage({ getString: (k) => fx.disk.get(k), set: (k, v) => { fx.disk.set(k, v); } });
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; });
async function show(order: any) {
  fx.order = order;
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(NewOrderTakeover, { queue: [{ orderId: order.id }], onDismiss: vi.fn() })));
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const selected = () => [...host.querySelectorAll('button[aria-checked="true"]')].map((b) => b.textContent);
const sent = () => fx.mutate.mock.calls.map((c) => c[0]);

describe('[APP-PREPTIME] the new-order alert accepts with a preparation time', () => {
  it('20 is pre-selected: ONE tap on Accept sends 20', async () => {
    await show(pending('o1'));
    expect(host.textContent).toContain('Preparation time');
    expect(selected()).toEqual(['20 min']);
    await act(async () => button('ACCEPT ORDER')!.click());
    expect(sent()).toEqual([{ id: 'o1', action: 'accept', prepMinutes: 20 }]);
  });

  it('45 tapped, then Accept: sends 45, and the next order starts at 45', async () => {
    await show(pending('o2'));
    await act(async () => button('45 min')!.click());
    expect(selected()).toEqual(['45 min']);
    await act(async () => button('ACCEPT ORDER')!.click());
    expect(sent()).toEqual([{ id: 'o2', action: 'accept', prepMinutes: 45 }]);
    await act(async () => root!.unmount()); root = undefined; host.remove();
    await show(pending('o3'));
    expect(selected()).toEqual(['45 min']);
  });

  it('a booking: no preparation time asked, none sent', async () => {
    await show(pending('o4', { fulfillment: 'APPOINTMENT', vendor: { vendorType: 'SERVICE' } }));
    expect(host.textContent).not.toContain('Preparation time');
    expect(host.textContent).not.toContain('Ready time');
    expect(button('20 min')).toBeUndefined();
    await act(async () => button('ACCEPT ORDER')!.click());
    expect(sent()).toEqual([{ id: 'o4', action: 'accept' }]);
  });

  it('a rejection carries its reason, never minutes', async () => {
    await show(pending('o5'));
    await act(async () => button('Reject — tell us why')!.click());
    const reason = [...host.querySelectorAll('button')].find((b) => /busy/i.test(b.textContent ?? ''))!;
    await act(async () => reason.click());
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ id: 'o5', action: 'reject' });
    expect(sent()[0]).not.toHaveProperty('prepMinutes');
  });
});
