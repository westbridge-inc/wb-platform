/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-PREPTIME · owner 14 Nov 2026] The full-screen new-order alert on the
// store's tablet: staff accept with a preparation time, like the website's
// takeover. [ROUND 2 · owner 14 Nov] The store's own declared prep time (the
// order carries it from checkout) is pre-selected, or the closest choice, so a
// busy kitchen still accepts in ONE tap; another time is one more tap and is
// remembered for the store on this device. A booking is never asked and sends
// no minutes. [REVIEW-B F1] The choices step aside while a reason to reject is
// asked, and the bottom of the alert scrolls so Back and "View later" are
// always reachable.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  order: null as any,
  mutate: vi.fn(),
  disk: new Map<string, string>(),
}));

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const flat = (st: any) => (Array.isArray(st) ? Object.assign({}, ...st) : st) ?? {};
  const Box = (p: any) => h('div', { role: p.accessibilityRole, 'aria-label': p.accessibilityLabel, 'data-testid': p.testID }, p.children);
  // A scroll area says it scrolls and carries its own style, so the layout rule is checked on the real tree.
  const Scroll = (p: any) => h('div', { 'data-scroll': 'true', 'data-testid': p.testID, 'data-style': JSON.stringify(flat(p.style)) }, p.children);
  const Press = (p: any) => h('button', { role: p.accessibilityRole, 'aria-checked': p.accessibilityState?.checked ? 'true' : 'false', disabled: p.disabled, onClick: p.onPress }, p.children);
  return { View: Box, ScrollView: Scroll, Modal: Box, Pressable: Press };
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
  const Text = (p: any) => h('span', { onClick: p.onPress, 'data-testid': p.testID }, p.children);
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
  id, orderNumber: `SW-${id}`, status: 'PENDING', vendorId: 'store-a', fulfillment: 'DELIVERY', estimatedPrepTime: 30,
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
  it('the store\'s own time (30) is pre-selected: ONE tap on Accept sends 30', async () => {
    await show(pending('o1'));
    expect(host.textContent).toContain('Preparation time');
    expect(selected()).toEqual(['30 min']);
    await act(async () => button('ACCEPT ORDER')!.click());
    expect(sent()).toEqual([{ id: 'o1', action: 'accept', prepMinutes: 30 }]);
  });

  it('a store that declared 45 starts at 45; one that declared 25 starts at the closest, longer choice, 30', async () => {
    await show(pending('o1a', { estimatedPrepTime: 45 }));
    expect(selected()).toEqual(['45 min']);
    await act(async () => root!.unmount()); root = undefined; host.remove();
    await show(pending('o1b', { estimatedPrepTime: 25 }));
    expect(selected()).toEqual(['30 min']);
    await act(async () => button('ACCEPT ORDER')!.click());
    expect(sent()).toEqual([{ id: 'o1b', action: 'accept', prepMinutes: 30 }]);
  });

  it('45 tapped, then Accept: sends 45, and the store\'s next order starts at 45', async () => {
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
    expect(button('30 min')).toBeUndefined();
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

describe('[REVIEW-B F1 · REVIEW-A S3-1] the alert keeps Back and "View later" reachable', () => {
  const chipsShown = () => !!host.querySelector('[role="radiogroup"]');

  it('the choices step aside while a reason to reject is asked, and come back on Back', async () => {
    await show(pending('o6'));
    expect(chipsShown()).toBe(true);
    await act(async () => button('Reject — tell us why')!.click());
    expect(chipsShown()).toBe(false);
    expect(button('Back')).toBeTruthy();
    await act(async () => button('Back')!.click());
    expect(chipsShown()).toBe(true);
    expect(selected()).toEqual(['30 min']);
  });

  it('the choices step aside while "reject the last item" is asked', async () => {
    await show(pending('o7'));
    await act(async () => button('Out of stock — reject the order')!.click());
    expect(host.textContent).toContain('This is the last item.');
    expect(chipsShown()).toBe(false);
  });

  it('the items keep a height of their own, and the decisions scroll above a pinned "View later"', async () => {
    await show(pending('o8'));
    const scrolls = [...host.querySelectorAll<HTMLElement>('[data-scroll="true"]')];
    const items = scrolls.find((el) => el.textContent?.includes('Cook-up'))!;
    const itemsStyle = JSON.parse(items.dataset['style']!);
    expect(itemsStyle.flex).toBe(1);
    expect(itemsStyle.minHeight).toBeGreaterThanOrEqual(64);
    const decide = host.querySelector<HTMLElement>('[data-testid="takeover-decide"]')!;
    expect(decide?.dataset['scroll']).toBe('true');
    const decideStyle = JSON.parse(decide.dataset['style']!);
    expect(decideStyle.flexGrow).toBe(0);
    expect(decideStyle.flexShrink).toBe(1);
    // Every decision lives in the scrolling block: the choices, Accept, Reject (and its reasons, and Back).
    expect(decide.querySelector('[role="radiogroup"]')).toBeTruthy();
    expect(decide.textContent).toContain('ACCEPT ORDER');
    await act(async () => button('Reject — tell us why')!.click());
    expect(decide.textContent).toContain('Back');
    // "View later" is never inside a scroll: it stays on screen whatever the height.
    const later = host.querySelector<HTMLElement>('[data-testid="takeover-view-later"]')!;
    expect(later.textContent).toContain('View later');
    expect(later.closest('[data-scroll="true"]')).toBeNull();
  });
});
