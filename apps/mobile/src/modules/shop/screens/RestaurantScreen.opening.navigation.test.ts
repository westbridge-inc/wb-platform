/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-SPEED A · owner 7 Nov] A tap on a store card used to open a blank
// spinner until the whole menu came back. The card now hands over the store's
// name and photo (route param `preview`, written from the server's own feed
// row): the store page draws them AT ONCE with the menu loading below, and
// nothing but Back can be pressed (no Add, no stepper, no heart, no report)
// until the store's own answer replaces it. The REAL RestaurantScreen on a
// real React renderer (the setup of RestaurantScreen.reuse).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  route: { name: 'Restaurant', params: {} as Record<string, unknown> },
  vendors: {} as Record<string, any>,
  loading: false,
  report: vi.fn(),
  goBack: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, ScrollView: View, Pressable: View, TextInput: () => null,
    FlatList: (p: any) => R.createElement('div', null, (p.data ?? []).map((item: any, i: number) => R.createElement(R.Fragment, { key: i }, p.renderItem({ item, index: i })))),
    Dimensions: { get: () => ({ width: 390, height: 844 }) }, Linking: { openURL: vi.fn() }, Share: { share: vi.fn() },
  };
});
// [APP-SPEED C] The menu is one FlashList: its header, every row (no windowing here) and its footer.
vi.mock('@shopify/flash-list', async () => {
  const R = await import('react');
  const FlashList = (p: any) => R.createElement('div', null, p.ListHeaderComponent ?? null,
    (p.data ?? []).map((item: any, i: number) => R.createElement(R.Fragment, { key: p.keyExtractor ? p.keyExtractor(item, i) : i }, p.renderItem({ item, index: i }))),
    p.ListFooterComponent ?? null);
  return { FlashList };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useRoute: () => fx.route, useNavigation: () => ({ navigate: vi.fn(), goBack: fx.goBack }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@swift/ui', () => ({ color: fx.token, font: fx.token, fontSize: fx.token, radius: fx.token, space: fx.token, withAlpha: () => 'c' }));
// [CHAINS PR3] The storefront asks with the customer's place; no place here (the device store is native).
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: null, longitude: null, status: 'denied' }) }));
vi.mock('../../../hooks/customer', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useVendor: (id: string) => ({ data: fx.loading ? undefined : fx.vendors[id], isLoading: fx.loading, isError: false, refetch: vi.fn() }),
    useCart: () => ({ data: undefined }),
    useReportContent: () => ({ mutate: fx.report, isPending: false }),
    useToggleFavorite: idle, useAddToCart: idle, useUpdateCartItem: idle,
  };
});
vi.mock('../../../kit/action-sheet', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    ActionSheet: (p: any) => p.open
      ? h('div', { role: 'dialog' }, p.actions.map((a: any) => h('button', { key: a.label, type: 'button', onClick: a.onPress }, a.label)))
      : null,
  };
});
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, wantsAuth: false, promptLogin: vi.fn() };
  return { useAuthStore: (select?: (s: typeof state) => unknown) => (select ? select(state) : state) };
});
vi.mock('../../../navigation/authContinuation', () => ({ requestAuthContinuation: vi.fn() }));
// [IMAGES-E2E #1909] The store hero asks for the hero width (1280 px variant).
// [IMAGES-E2E #1973] Each menu section can carry its photo (SectionPhotoHeader): no photo here, so the plain
// section header shows; the native image view is not loaded.
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('../../../lib/images', () => ({ HERO_PHOTO_WIDTH: 1280, LIST_PHOTO_WIDTH: 640, categoryPhoto: () => null, itemPhoto: () => null, vendorPhoto: (v: any, w: number) => (v?.coverImageUrl ? `${v.coverImageUrl}@${w}` : null) }));
vi.mock('../../../components/SellerInfo', () => ({ SellerInfo: () => null }));
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../kit/scrim', () => ({ Scrim: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  const Nothing = () => null;
  return {
    AddMorph: (p: any) => h('button', { type: 'button', onClick: p.onAdd }, 'Add'), CartBar: Nothing, useCartBarClearance: () => 0, ErrorState: Nothing, FoodCard: Nothing,
    HeartBadge: (p: any) => h('button', { type: 'button', 'aria-label': 'Favourite', onClick: p.onPress }), IconChip: Nothing,
    LoadingBlock: () => h('div', { 'data-loading': '' }), Header: () => h('div', { 'data-header': '' }), Money: Nothing, Photo: (p: any) => h('img', { alt: p.label, src: p.uri ?? undefined }), TonePill: Nothing,
    PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null), PopupTitle: Box,
    T: (p: any) => h('span', null, p.children), SectionHeader: (p: any) => h('h3', null, p.title),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    Chip: (p: any) => h('button', { type: 'button', 'data-chip': p.label, 'aria-pressed': p.selected ? 'true' : 'false', onClick: p.onPress }, p.label),
    CircleChip: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.onPress }),
    MenuRow: (p: any) => h('div', { 'data-menu-row': p.name }, p.name, h('button', { type: 'button', onClick: p.onAdd }, 'Add')),
  };
});

import { RestaurantScreen } from './RestaurantScreen';

const STORE = {
  id: 'a', name: 'Store a', vendorType: 'RESTAURANT', isCurrentlyOpen: true, operatingHours: [], activePromos: [],
  categories: [{ id: 'a-mains', name: 'Mains', items: [{ id: 'a-curry', name: 'Curry chicken', basePrice: 1000 }] }],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
async function show(params: Record<string, unknown>) {
  fx.route = { ...fx.route, params };
  await act(async () => root.render(React.createElement(RestaurantScreen)));
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.vendors = { a: STORE };
  fx.loading = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[APP-SPEED A] a store opens on what its card showed', () => {
  it('name and photo at once, the menu loading below, only Back to press; the store’s answer replaces it', async () => {
    await show({ vendorId: 'a', preview: { name: 'Store a', coverImageUrl: 'items/a/cover', logoUrl: null } });

    // (a) instantly, from the card
    expect(host.textContent).toContain('Store a');
    expect(host.querySelector('img')?.getAttribute('src'), 'the hero width of the card’s own photo').toBe('items/a/cover@1280');
    expect(host.querySelector('[data-loading]'), 'the menu’s place is loading').not.toBeNull();
    // (b) nothing that changes the cart, a favourite or a report
    expect(buttons()).toEqual(['Back']);
    expect(host.querySelectorAll('[data-menu-row]')).toHaveLength(0);
    await act(async () => { (host.querySelector('[aria-label="Back"]') as HTMLButtonElement).click(); });
    expect(fx.goBack).toHaveBeenCalledTimes(1);

    // (c) the store's own answer
    fx.loading = false;
    await show({ vendorId: 'a', preview: { name: 'Store a', coverImageUrl: 'items/a/cover', logoUrl: null } });
    expect(host.querySelector('[data-loading]')).toBeNull();
    expect([...host.querySelectorAll('[data-menu-row]')].map((n) => n.getAttribute('data-menu-row'))).toEqual(['Curry chicken']);
    expect(buttons()).toEqual(expect.arrayContaining(['Favourite', 'Report this store', 'Add']));
  });

  it('no card (a link, a scan, an older caller) or a malformed one: the plain loading state, as before', async () => {
    await show({ vendorId: 'a' });
    expect(host.textContent).not.toContain('Store a');
    expect(host.querySelector('[data-loading]')).not.toBeNull();
    await show({ vendorId: 'a', preview: { name: '   ', coverImageUrl: 7 } });
    expect(host.textContent).not.toContain('Store a');
    expect(host.querySelector('img')).toBeNull();
  });
});
