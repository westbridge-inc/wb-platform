/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-SPEED A · owner 7 Nov] A dish card on Home or Search opened a blank
// spinner until its store's whole menu came back. The card now hands over the
// dish's name and photo (route param `preview`, from the server's own feed
// row): the item page draws them AT ONCE, the rest loading below, with no Add,
// no quantity and no price until the store's menu answers. The REAL
// MenuItemScreen on a real React renderer; native drawing, the kit, the store
// read and the stores are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  route: { name: 'MenuItem', params: {} as Record<string, unknown> },
  vendor: { isLoading: true, isError: false, data: undefined as any, refetch: () => {} },
  add: vi.fn(),
  goBack: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, p.children);
  return { View, ScrollView: View, Dimensions: { get: () => ({ width: 390, height: 844 }) } };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({
  useRoute: () => fx.route,
  useNavigation: () => ({ navigate: vi.fn(), goBack: fx.goBack, setParams: vi.fn(), getParent: () => undefined }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@swift/ui', () => ({ color: fx.token, elevation: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../hooks/customer', () => ({
  useVendor: () => fx.vendor,
  useAddToCart: () => ({ mutate: fx.add, isPending: false, isError: false }),
  useItemSlots: () => ({ data: undefined, isPending: false, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: () => ({ isAuthenticated: true, wantsAuth: false, promptLogin: vi.fn() }) }));
vi.mock('../../../stores/bookingStore', () => ({ useBookingStore: (select: (state: unknown) => unknown) => select({ setAppointment: vi.fn() }) }));
vi.mock('../../../navigation/authContinuation', () => ({ requestAuthContinuation: vi.fn() }));
vi.mock('../../../lib/images', () => ({ HERO_PHOTO_WIDTH: 1280, itemPhoto: (item: any, w = 640) => (item?.imageUrl ? `${item.imageUrl}@${w}` : null) }));
vi.mock('../../../lib/money', () => ({ money: (amount: number) => `GY$${amount}` }));
vi.mock('../components/ItemDescription', () => ({ ItemDescription: () => null }));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  const Nothing = () => null;
  return {
    Photo: (p: any) => h('img', { alt: p.label, src: p.uri ?? undefined }),
    CircleChip: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }),
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, disabled: !!(p.disabled || p.loading), onClick: p.onPress }, p.label),
    QtyStepper: () => h('button', { type: 'button', 'aria-label': 'Quantity' }),
    Money: (p: any) => h('span', { 'data-money': '' }, `GY$${p.amount}`),
    T: (p: any) => h('span', null, p.children),
    LoadingBlock: () => h('div', { 'data-loading': '' }), Header: () => h('div', { 'data-header': '' }),
    ErrorState: Nothing, EmptyState: Nothing, Chip: Nothing, IconChip: Nothing, LabeledInput: Nothing, TonePill: Nothing,
    PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null), PopupTitle: Box, SectionHeader: Nothing,
  };
});

import { MenuItemScreen } from './MenuItemScreen';

const STORE = { name: 'Store a', categories: [{ items: [{ id: 'curry', name: 'Curry chicken', basePrice: 1000, imageUrl: 'items/a/curry', optionGroups: [] }] }] };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
async function show(params: Record<string, unknown>) {
  fx.route = { ...fx.route, params };
  await act(async () => root.render(React.createElement(MenuItemScreen)));
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.vendor = { isLoading: true, isError: false, data: undefined, refetch: () => {} };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[APP-SPEED A] a dish opens on what its card showed', () => {
  it('photo and name at once; no Add, no quantity, no price until the store answers; then the real item', async () => {
    const params = { vendorId: 'a', itemId: 'curry', preview: { name: 'Curry chicken', imageUrl: 'items/a/curry' } };
    await show(params);

    // (a) instantly, from the card
    expect(host.textContent).toContain('Curry chicken');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('items/a/curry@1280');
    expect(host.querySelector('[data-loading]')).not.toBeNull();
    // (b) nothing that adds to the cart or states a price
    expect(buttons()).toEqual(['Back']);
    expect(host.querySelector('[data-money]')).toBeNull();
    await act(async () => { (host.querySelector('[aria-label="Back"]') as HTMLButtonElement).click(); });
    expect(fx.goBack).toHaveBeenCalledTimes(1);

    // (c) the store's menu answers
    fx.vendor = { isLoading: false, isError: false, data: STORE, refetch: () => {} };
    await show(params);
    expect(host.querySelector('[data-loading]')).toBeNull();
    expect(host.querySelector('[data-money]')?.textContent).toBe('GY$1000');
    expect(buttons().some((label) => /^Add/.test(label ?? '')), 'Add is offered once the store answered').toBe(true);
    expect(fx.add).not.toHaveBeenCalled();
  });

  it('no card (Restaurant, a link, an older caller): the plain loading state with the kit header, as before', async () => {
    await show({ vendorId: 'a', itemId: 'curry' });
    expect(host.querySelector('[data-header]')).not.toBeNull();
    expect(host.querySelector('[data-loading]')).not.toBeNull();
    expect(host.textContent).not.toContain('Curry chicken');
  });
});
