/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [OOS-FLOW · owner 8 Nov 2026] "i said out of stock in dashboard but customer
// sees it but order doesnt get cancelled nor can they get a replacement".
// After the store ACCEPTED: a line's "Out of stock?" names both ways out
// ("Remove item", or offer a replacement the customer approves or declines);
// the last item still coming asks once before it is removed (the server then
// cancels the order as out of stock); an order emptied on an older server says
// what to do instead of a silent Ready refusal. The REAL
// VendorOrderDetailScreen on a real React renderer; only native drawing, the
// kit, the order read and the network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  reads: 0,
  menu: [] as any[],
  refund: { mutate: vi.fn(), isPending: false, isError: false, error: null } as any,
  substitute: { mutate: vi.fn(), isPending: false, isError: false, error: null } as any,
  act: { mutate: vi.fn(), isPending: false, isError: false, error: null } as any,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  // A pressable is a real button here, named by its accessibility label when it has one.
  const Pressable = (p: any) => R.createElement('button', { type: 'button', onClick: p.onPress, 'aria-label': p.accessibilityLabel }, p.children);
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
    CodeInput: () => null,
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    PopupCard: (p: any) => p.visible ? h('div', { role: 'dialog' }, p.children) : null,
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), show: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../../orders/CustodyRecoveryNotice', () => ({ CustodyRecoveryNotice: () => null }));
vi.mock('../shared', async () => {
  const R = await import('react');
  return {
    GUTTER: 16,
    SubHeader: (p: any) => R.createElement('header', null, p.title),
    OrderStatusPill: () => null, FulfillmentTag: () => null, MmgDisputeNotice: () => null,
    fmtClock: () => '', fmtWhen: () => '', formatSlot: () => '',
    prettyStatus: (s?: string) => (s || '').toLowerCase(),
    orderActions: () => [],
  };
});
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  return {
    useVendorOrder: (id?: string) => { fx.reads += 1; return { data: id ? fx.orders[id] : undefined, isLoading: false, isError: false, refetch: vi.fn() }; },
    useOrderAction: () => fx.act, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: idle(), substitute: fx.substitute, refundLine: fx.refund }),
    usePendingPickLines: () => new Set(),
    useVendorMenu: () => ({ data: fx.menu }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const line = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, itemId: `item-${id}`, name, quantity: 1, totalBase: 1000, subStatus: 'NONE', picked: false, ...extra });
const order = (extra: Record<string, unknown>) => ({
  id: 'a', orderNumber: 'A', statusHistory: [], customer: { firstName: 'Customer' },
  vendor: { vendorType: 'STORE' }, paymentMethod: 'CASH', fulfillment: 'PICKUP', status: 'PREPARING',
  items: [line('l1', 'Shirt'), line('l2', 'Vest')], ...extra,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function show(o: Record<string, unknown>) {
  fx.orders = { a: o };
  await act(async () => root.render(React.createElement(VendorOrderDetailScreen, {
    navigation: { goBack: vi.fn(), navigate: vi.fn() }, route: { name: 'VendorOrderDetail', params: { orderId: 'a' } },
  })));
  return host.textContent ?? '';
}
const buttons = (label: string) => [...host.querySelectorAll('button')].filter((b) => b.textContent === label);
const outOfStock = (name: string) => [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === `${name}: out of stock? Remove it or offer a replacement`)!;
const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); };

beforeEach(() => {
  fx.refund.mutate = vi.fn();
  fx.substitute.mutate = vi.fn();
  fx.act.mutate = vi.fn();
  fx.reads = 0;
  fx.menu = [{ id: 'cat-1', items: [
    { id: 'item-l1', name: 'Shirt', basePrice: 1000, isAvailable: true },
    { id: 'item-l2', name: 'Vest', basePrice: 1000, isAvailable: true },
    { id: 'item-x', name: 'Tank top', basePrice: 1200, isAvailable: true },
  ] }, { id: 'cat-2', items: [{ id: 'item-y', name: 'Hoodie', basePrice: 4000, isAvailable: true }] }];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[OOS-FLOW] after accepting: "Out of stock?" names both ways out', () => {
  it('opens to "Remove item" and a replacement list from the same section, with prices', async () => {
    await show(order({}));
    await click(outOfStock('Vest'));
    const text = host.textContent ?? '';
    expect(text).toContain('Out of stock — remove it, or offer a replacement:');
    expect(text).toContain('Offer a replacement (the customer approves or declines in the app):');
    expect(buttons('Remove item')).toHaveLength(1);
    expect(buttons('Refund line')).toHaveLength(0); // never "refund": on cash nothing was charged
    const offer = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Tank top · '));
    await click(offer);
    expect(fx.substitute.mutate).toHaveBeenCalledWith({ orderId: 'a', lineId: 'l2', substituteItemId: 'item-x' });
    expect(fx.refund.mutate).not.toHaveBeenCalled();
  });

  it('"Show all items" widens the list to every item in stock', async () => {
    await show(order({}));
    await click(outOfStock('Vest'));
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Hoodie'))).toBe(false);
    await click(buttons('Show all items')[0]);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Hoodie'))).toBe(true);
    expect(buttons('Show all items')).toHaveLength(0);
  });

  it('"Show all items" never offers what the server refuses: an item in a substitution group stays in its group', async () => {
    fx.menu = [{ id: 'cat-1', items: [
      { id: 'item-l1', name: 'Shirt', basePrice: 1000, isAvailable: true },
      { id: 'item-l2', name: 'Vest', basePrice: 1000, isAvailable: true, substitutionGroup: 'tops' },
      { id: 'item-x', name: 'Tank top', basePrice: 1200, isAvailable: true, substitutionGroup: 'tops' },
    ] }, { id: 'cat-2', items: [
      { id: 'item-y', name: 'Hoodie', basePrice: 4000, isAvailable: true },
      { id: 'item-z', name: 'Polo', basePrice: 1500, isAvailable: true, substitutionGroup: 'tops' },
    ] }];
    await show(order({}));
    await click(outOfStock('Vest'));
    await click(buttons('Show all items')[0]);
    const offered = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(offered.some((t) => t.startsWith('Polo · '))).toBe(true); // same group, another section
    expect(offered.some((t) => t.startsWith('Tank top · '))).toBe(true);
    expect(offered.some((t) => t.startsWith('Hoodie'))).toBe(false); // WRONG_GROUP on the server
    expect(offered.some((t) => t.startsWith('Shirt · '))).toBe(false);
  });

  it('not the last item: "Remove item" removes it at once', async () => {
    await show(order({}));
    await click(outOfStock('Vest'));
    await click(buttons('Remove item')[0]);
    expect(fx.refund.mutate).toHaveBeenCalledTimes(1);
    expect(fx.refund.mutate).toHaveBeenCalledWith({ orderId: 'a', lineId: 'l2' }, undefined);
  });

  it('the last item still coming: asked once (it cancels the order), "Keep it" sends nothing, yes removes it', async () => {
    await show(order({ items: [line('l1', 'Shirt', { subStatus: 'REFUNDED' }), line('l2', 'Vest')] }));
    await click(outOfStock('Vest'));
    await click(buttons('Remove item')[0]);
    expect(fx.refund.mutate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('This is the last item on the order. Removing it cancels the order as out of stock, and the customer is told right away. You can offer a replacement instead.');
    await click(buttons('Keep it')[0]);
    expect(fx.refund.mutate).not.toHaveBeenCalled();
    // Back on the two ways out (a replacement is still one tap away).
    expect(host.textContent).toContain('Offer a replacement (the customer approves or declines in the app):');
    await click(buttons('Remove item')[0]);
    await click(buttons('Remove and cancel the order')[0]);
    expect(fx.refund.mutate).toHaveBeenCalledTimes(1);
    expect(fx.refund.mutate.mock.calls[0]![0]).toEqual({ orderId: 'a', lineId: 'l2' });
    expect(typeof fx.refund.mutate.mock.calls[0]![1]?.onSuccess).toBe('function');
  });

  it('a swap waiting on the customer for the last item: "Remove item instead" asks once too', async () => {
    await show(order({ items: [line('l1', 'Shirt', { subStatus: 'REJECTED' }), line('l2', 'Vest', { subStatus: 'PENDING', substituteName: 'Tank top' })] }));
    await click([...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Remove Vest instead'));
    expect(fx.refund.mutate).not.toHaveBeenCalled();
    await click(buttons('Remove and cancel the order')[0]);
    expect(fx.refund.mutate).toHaveBeenCalledTimes(1);
  });

  it('a removed line reads "Removed — not charged", never "Refunded"', async () => {
    const text = await show(order({ items: [line('l1', 'Shirt', { subStatus: 'REFUNDED' }), line('l2', 'Vest')] }));
    expect(text).toContain('Removed — not charged');
    expect(text).not.toContain('Refunded');
  });
});

describe('[OOS-FLOW] an order emptied on an older server is never a silent Ready refusal', () => {
  it('still rejectable: says why, and "Reject: out of stock" rejects it with that reason', async () => {
    const text = await show(order({ items: [line('l1', 'Shirt', { subStatus: 'REFUNDED' }), line('l2', 'Vest', { subStatus: 'REJECTED' })] }));
    expect(text).toContain('Every item on this order came off as out of stock, so there is nothing to hand over. Reject it with the reason “Out of stock”');
    await click(buttons('Reject: out of stock')[0]);
    expect(fx.act.mutate).toHaveBeenCalledWith({ id: 'a', action: 'reject', reason: 'Out of stock' });
  });

  it('past the stages a store may reject from: Swift support closes it, and no button pretends otherwise', async () => {
    const text = await show(order({ status: 'RIDER_ASSIGNED', fulfillment: 'DELIVERY', items: [line('l1', 'Shirt', { subStatus: 'REFUNDED' })] }));
    expect(text).toContain('Contact Swift support to close it.');
    expect(buttons('Reject: out of stock')).toHaveLength(0);
  });

  it('control: a cancelled order shows neither', async () => {
    const text = await show(order({ status: 'CANCELLED', items: [line('l1', 'Shirt', { subStatus: 'REFUNDED' })] }));
    expect(text).not.toContain('nothing to hand over');
  });
});

describe('[OOS-FLOW] no render loop', () => {
  it('opening the screen and the out-of-stock panel reads the order a bounded number of times', async () => {
    await show(order({}));
    await click(outOfStock('Vest'));
    await click(buttons('Show all items')[0]);
    expect(fx.reads).toBeLessThan(10);
  });
});
