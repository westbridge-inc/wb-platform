/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [STORE-WORDS sweep · owner 9 Nov 2026] A clothing shop saw kitchen words on its own order screen: the
// quoted time read "Quoted prep time" and the reject reasons offered "Kitchen is too busy", which the
// customer is then shown. The REAL VendorOrderDetailScreen on a real React renderer (the harness of
// VendorOrderDetailScreen.words.navigation.test.ts): a restaurant keeps its words exactly; a shop does not.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  actions: [] as Array<{ label: string; action: string }>,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return { View, ScrollView: View, Pressable: View, Linking: { openURL: vi.fn() } };
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
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../../orders/CustodyRecoveryNotice', () => ({ CustodyRecoveryNotice: () => null }));
vi.mock('../shared', async () => {
  const R = await import('react');
  return {
    GUTTER: 16,
    SubHeader: (p: any) => R.createElement('header', null, p.title),
    OrderStatusPill: () => null, FulfillmentTag: () => null, MmgDisputeNotice: () => null,
    fmtClock: () => '', fmtWhen: () => '', formatSlot: () => '',
    // The old history helper (code with spaces), so a screen that still uses it renders its real old words.
    prettyStatus: (s?: string) => { const t = (s || '').replace(/_/g, ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); },
    orderActions: () => fx.actions,
  };
});
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  return {
    useVendorOrder: (id?: string) => ({ data: id ? fx.orders[id] : undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    useOrderAction: idle, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: idle(), substitute: idle(), refundLine: idle() }),
    usePendingPickLines: () => new Set(), // [TAP-AUDIT] no pick tick on its way
    useVendorMenu: () => ({ data: [] }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const order = (extra: Record<string, unknown>) => ({
  id: 'a', orderNumber: 'A', items: [], statusHistory: [], customer: { firstName: 'Customer' },
  vendor: { vendorType: 'RESTAURANT' }, paymentMethod: 'CASH', fulfillment: 'DELIVERY', ...extra,
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

beforeEach(() => {
  fx.actions = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[STORE-WORDS sweep] the store order screen speaks the store\'s kind', () => {
  it('a restaurant keeps "Quoted prep time" exactly', async () => {
    const text = await show(order({ status: 'ACCEPTED', estimatedPrepTime: 20 }));
    expect(text).toContain('Quoted prep time: 20 min');
  });

  it('a shop, a supermarket or a store of unknown kind quoted a "ready time", never a prep time', async () => {
    for (const vendor of [{ vendorType: 'STORE' }, { vendorType: 'SUPERMARKET' }, {}]) {
      const text = await show(order({ status: 'ACCEPTED', estimatedPrepTime: 20, vendor }));
      expect(text, JSON.stringify(vendor)).toContain('Quoted ready time: 20 min');
      expect(text, JSON.stringify(vendor)).not.toMatch(/\bprep\b/i);
    }
  });

  async function reasonsFor(vendor: Record<string, unknown>) {
    fx.actions = [{ label: 'Reject', action: 'reject' }];
    await show(order({ status: 'PENDING', vendor }));
    const reject = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Reject');
    expect(reject).toBeTruthy();
    await act(async () => reject!.click());
    const dialog = host.querySelector('[role="dialog"]');
    return [...(dialog?.querySelectorAll('button') ?? [])].map((b) => b.textContent ?? '');
  }

  it('a restaurant rejects with "Kitchen is too busy", unchanged', async () => {
    expect(await reasonsFor({ vendorType: 'RESTAURANT' })).toEqual(expect.arrayContaining(['Out of stock', 'Kitchen is too busy', 'Closing soon']));
  });

  it('a shop never tells its customer the kitchen is busy', async () => {
    const reasons = await reasonsFor({ vendorType: 'STORE' });
    expect(reasons).toEqual(expect.arrayContaining(['Out of stock', 'Too busy right now', 'Closing soon']));
    expect(reasons.join(' ')).not.toMatch(/kitchen/i);
  });
});
