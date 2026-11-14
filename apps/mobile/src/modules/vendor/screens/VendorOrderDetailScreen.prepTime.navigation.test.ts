/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-PREPTIME · owner 14 Nov 2026] The store order screen's Accept (the one a
// tablet reaches from the board) asks the preparation time like the website's
// order page: [ROUND 2 · owner 14 Nov] the store's own declared prep time (or
// the closest choice) pre-selected, one more tap for another time, the minutes
// sent with the Accept; a booking is never asked. [REVIEW-B F3] While the
// choices are asked, the "Quoted prep time" line says the chosen time, never a
// second number. The REAL VendorOrderDetailScreen on a real React renderer
// (the harness of VendorOrderDetailScreen.reuse).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  mutate: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  // A chip is a real button here, so a tap on "45 min" is a tap.
  const Pressable = (p: any) => R.createElement('button', { type: 'button', 'data-chip': p.accessibilityLabel, 'aria-checked': p.accessibilityState?.checked ? 'true' : 'false', disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.children);
  return { View, ScrollView: View, Pressable, Linking: { openURL: vi.fn() } };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    Card: Box, Screen: Box, InfoRow: () => null, IconChip: () => null, LoadingBlock: () => null, ErrorState: () => null,
    T: (p: any) => h('span', null, p.children), PopupTitle: (p: any) => h('h2', null, p.children),
    Chip: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    CodeInput: (p: any) => h('input', { 'aria-label': 'collection code', value: p.value, onChange: (e: any) => p.onChange(e.target.value) }),
    PillButton: (p: any) => h('button', { type: 'button', 'data-pill': p.label, disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.label),
    PopupCard: (p: any) => p.visible ? h('div', { role: 'dialog' }, p.children) : null,
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../../orders/CustodyRecoveryNotice', () => ({ CustodyRecoveryNotice: () => null }));
vi.mock('../shared', async () => {
  const R = await import('react');
  return {
    GUTTER: 16,
    SubHeader: (p: any) => R.createElement('header', null, p.title),
    OrderStatusPill: () => null, FulfillmentTag: () => null, MmgDisputeNotice: () => null,
    fmtClock: () => '', fmtWhen: () => '', formatSlot: () => '', prettyStatus: (s: string) => s,
    // The real board's choice for the three states under test (shared.tsx statusActions).
    orderActions: (order: any) => order.status === 'PENDING'
      ? [{ label: 'Accept', action: 'accept' }, { label: 'Reject', action: 'reject' }]
      : order.status === 'READY_FOR_PICKUP' && order.fulfillment === 'PICKUP'
        ? [{ label: 'Mark picked up', action: 'complete-pickup' }]
        : order.status === 'RIDER_EN_ROUTE_DELIVERY' ? [{ label: 'Confirm delivered', action: 'delivered' }] : [],
  };
});
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: fx.mutate, isPending: false, isError: false, error: null });
  return {
    useVendorOrder: (id?: string) => ({ data: id ? fx.orders[id] : undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    useOrderAction: idle, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: idle(), substitute: idle(), refundLine: idle() }),
    usePendingPickLines: () => new Set(), // [TAP-AUDIT] no pick tick on its way
    useVendorMenu: () => ({ data: [] }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';
import { bindPrepTimeStorage } from '../prepTimeMemory';

const order = (id: string, extra: Record<string, unknown>) => ({
  id, orderNumber: id.toUpperCase(), items: [], statusHistory: [], customer: { firstName: `Customer ${id}` },
  vendor: { vendorType: 'RESTAURANT' }, paymentMethod: 'CASH', estimatedPrepTime: 30, ...extra,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigation = { goBack: vi.fn(), navigate: vi.fn() };
const disk = new Map<string, string>();
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[data-pill="${label}"]`);
const chip = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button[data-chip]')].find((b) => b.textContent === label);
const checked = () => [...host.querySelectorAll('button[data-chip][aria-checked="true"]')].map((b) => b.textContent);
const click = async (el: Element) => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
async function show(orderId: string) {
  await act(async () => root.render(React.createElement(VendorOrderDetailScreen, {
    navigation, route: { name: 'VendorOrderDetail', params: { orderId } },
  })));
}

beforeEach(() => {
  vi.clearAllMocks();
  disk.clear();
  bindPrepTimeStorage({ getString: (k) => disk.get(k), set: (k, v) => { disk.set(k, v); } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[APP-PREPTIME] the store order screen accepts with a preparation time', () => {
  it('the store\'s own time pre-selected: Accept sends 30', async () => {
    fx.orders = { a: order('a', { status: 'PENDING', fulfillment: 'DELIVERY', vendorId: 'store-a' }) };
    await show('a');
    expect(host.textContent).toContain('Preparation time');
    expect(checked()).toEqual(['30 min']);
    await click(button('Accept')!);
    expect(fx.mutate).toHaveBeenCalledExactlyOnceWith({ id: 'a', action: 'accept', prepMinutes: 30 });
  });

  it('a store that declared 15 starts at 15; 40 starts at the closest choice, 45', async () => {
    fx.orders = { a1: order('a1', { status: 'PENDING', fulfillment: 'DELIVERY', vendorId: 'store-a', estimatedPrepTime: 15 }) };
    await show('a1');
    expect(checked()).toEqual(['15 min']);
    fx.orders = { a2: order('a2', { status: 'PENDING', fulfillment: 'DELIVERY', vendorId: 'store-a', estimatedPrepTime: 40 }) };
    await show('a2');
    expect(checked()).toEqual(['45 min']);
    await click(button('Accept')!);
    expect(fx.mutate).toHaveBeenCalledExactlyOnceWith({ id: 'a2', action: 'accept', prepMinutes: 45 });
  });

  it('[REVIEW-B F3] the waiting order\'s "Quoted prep time" is the time the choices hold, never a second number', async () => {
    fx.orders = { q: order('q', { status: 'PENDING', fulfillment: 'DELIVERY', vendorId: 'store-a', estimatedPrepTime: 25 }) };
    await show('q');
    expect(checked()).toEqual(['30 min']);
    expect(host.textContent).toContain('Quoted prep time: 30 min');
    expect(host.textContent).not.toContain('25 min');
    await click(chip('60 min')!);
    expect(host.textContent).toContain('Quoted prep time: 60 min');
    expect(host.textContent).not.toContain('Quoted prep time: 30 min');
  });

  it('after the decision, the line is the time the order was accepted with', async () => {
    fx.orders = { r: order('r', { status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP', vendorId: 'store-a', estimatedPrepTime: 25 }) };
    await show('r');
    expect(host.textContent).toContain('Quoted prep time: 25 min');
  });

  it('60 tapped: Accept sends 60', async () => {
    fx.orders = { b: order('b', { status: 'PENDING', fulfillment: 'PICKUP', vendorId: 'store-a' }) };
    await show('b');
    await click(chip('60 min')!);
    expect(checked()).toEqual(['60 min']);
    await click(button('Accept')!);
    expect(fx.mutate).toHaveBeenCalledExactlyOnceWith({ id: 'b', action: 'accept', prepMinutes: 60 });
  });

  it('a booking: nothing asked, nothing sent', async () => {
    fx.orders = { c: order('c', { status: 'PENDING', fulfillment: 'APPOINTMENT', vendorId: 'store-a', vendor: { vendorType: 'SERVICE' } }) };
    await show('c');
    expect(chip('30 min')).toBeUndefined();
    await click(button('Accept')!);
    expect(fx.mutate).toHaveBeenCalledExactlyOnceWith({ id: 'c', action: 'accept' });
  });

  it('past the decision (preparing), no choices are shown', async () => {
    fx.orders = { d: order('d', { status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP', vendorId: 'store-a' }) };
    await show('d');
    expect(chip('30 min')).toBeUndefined();
    expect(host.textContent).not.toContain('Preparation time');
  });
});
