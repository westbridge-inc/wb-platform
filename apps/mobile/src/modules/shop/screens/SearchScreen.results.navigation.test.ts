/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { engineSearchRows, searchRowKey } from '../../../lib/searchRows';

// ---------------------------------------------------------------------------
// [APP-SPEED C · report item 12] A text search ("chicken") answers with places AND dishes. The results used to be a
// ScrollView that mounted every row of the answer at once, each with its photo: a long answer opened slowly on the
// launch market's phones. They are now ONE FlatList (places, then dishes), so only the rows near the screen are drawn.
// The REAL screen; native drawing is a stand-in: the FlatList draws its rows inside a marked box, the way the native
// list owns them, and records the keys it was given.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  vendors: [] as any[],
  items: [] as any[],
  lists: [] as Array<{ keys: string[] }>,
  navigate: vi.fn(),
}));

vi.mock('react-native', async () => {
  const { createElement: h, Fragment } = await import('react');
  const kids = (p: any) => (typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  const el = (c: any) => (c == null ? null : React.isValidElement(c) ? c : h(c));
  return {
    View: (p: any) => h('div', null, kids(p)),
    ScrollView: (p: any) => h('div', { 'data-rn': 'scroll' }, kids(p)),
    Text: (p: any) => h('span', null, p.children),
    Pressable: (p: any) => h('button', { onClick: p.onPress, 'aria-label': p.accessibilityLabel }, kids(p)),
    TextInput: (p: any) => h('input', { value: p.value, readOnly: true }),
    FlatList: (p: any) => {
      const data: any[] = p.data ?? [];
      const keys = data.map((item, index) => p.keyExtractor(item, index));
      fx.lists.push({ keys });
      return h('div', { 'data-rn': 'flatlist' }, el(p.ListHeaderComponent),
        data.map((item, index) => h(Fragment, { key: keys[index] }, index > 0 && p.ItemSeparatorComponent ? el(p.ItemSeparatorComponent) : null, p.renderItem({ item, index }))));
    },
    Switch: () => null,
    StyleSheet: { flatten: (s: any) => s, create: (x: any) => x, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 3 }),
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  };
});
vi.mock('react-native-svg', () => ({ default: () => null, Path: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: fx.navigate, goBack: vi.fn() }), useRoute: () => ({ params: { q: 'chicken' } }) }));
vi.mock('../../../lib/haptics', () => ({ haptic: { select: vi.fn() } }));
vi.mock('../../../kit/action-sheet', () => ({ ActionSheet: () => null }));
vi.mock('../../../stores/appStore', () => ({ useAppStore: () => ({ recentSearches: [], pushSearch: () => {}, clearSearches: () => {} }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: null, longitude: null, status: 'denied' }) }));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => undefined, vendorPhoto: () => undefined }));
vi.mock('../../../hooks/storeDoor', () => ({ useVendorPrefetch: () => () => ({}) }));
vi.mock('../../../hooks/customer', () => {
  const q = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
  return {
    useHome: () => q({ popularItems: [] }),
    useVendors: () => q([]),
    useSearch: () => q({ vendors: fx.vendors, items: fx.items }),
    useSearchSuggestions: () => q([]),
    useSearchTrending: () => q([]),
  };
});
vi.mock('../../../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  return {
    Chip: (p: any) => h('button', { onClick: p.onPress }, p.label),
    Screen: Box, T: (p: any) => h('span', null, p.children), SectionHeader: (p: any) => h('h2', null, p.title),
    CartBar: () => null, useCartBarClearance: () => 0,
    EmptyState: (p: any) => h('section', null, p.title), ErrorState: () => h('div', null, 'Error'), LoadingBlock: () => null,
    Money: () => null, Photo: () => null, RatingMeta: () => null,
  };
});

import { SearchScreen } from './SearchScreen';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined;
});

async function renderSearch() {
  fx.lists = [];
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(SearchScreen))));
}
const place = (i: number) => ({ id: `s${i}`, name: `Store ${i}`, isCurrentlyOpen: true });
const dish = (i: number) => ({ id: `d${i}`, name: `Dish ${i}`, vendorId: 's1', vendorName: 'Store 1', basePrice: 1000 });

describe('[APP-SPEED C] Search results are one virtualised list', () => {
  it('every place and every dish of the answer is a row of the FlatList, never mounted in a ScrollView', async () => {
    fx.vendors = Array.from({ length: 30 }, (_, i) => place(i + 1));
    fx.items = Array.from({ length: 40 }, (_, i) => dish(i + 1));
    await renderSearch();
    const list = host.querySelector('[data-rn="flatlist"]');
    expect(list, 'the results are a FlatList').not.toBeNull();
    const rowsIn = (el: Element | null) => [...(el?.querySelectorAll('button[aria-label]') ?? [])].map((b) => b.getAttribute('aria-label'));
    expect(rowsIn(list).filter((l) => l?.startsWith('Store '))).toHaveLength(30);
    expect(rowsIn(list).filter((l) => l?.startsWith('Dish '))).toHaveLength(40);
    for (const scroll of host.querySelectorAll('[data-rn="scroll"]')) {
      expect(rowsIn(scroll).filter((l) => l?.startsWith('Store ') || l?.startsWith('Dish ')), 'no result row in a ScrollView').toEqual([]);
    }
    const keys = fx.lists.at(-1)!.keys;
    expect(new Set(keys).size, 'every row has its own key').toBe(keys.length);
    // Places first (under their count line), then the "Dishes" heading and the dishes.
    expect(host.textContent).toMatch(/30 places · sorted by relevance[\s\S]*Store 30[\s\S]*Dishes[\s\S]*Dish 1/);
  });

  it('a dish opens its item; a place opens its store', async () => {
    fx.vendors = [place(1)];
    fx.items = [dish(1)];
    await renderSearch();
    await act(async () => (host.querySelector('button[aria-label="Dish 1. Store 1"]') as HTMLButtonElement).click());
    expect(fx.navigate).toHaveBeenLastCalledWith('MenuItem', expect.objectContaining({ itemId: 'd1', vendorId: 's1' }));
    await act(async () => (host.querySelector('button[aria-label="Store 1"]') as HTMLButtonElement).click());
    expect(fx.navigate).toHaveBeenLastCalledWith('Restaurant', expect.objectContaining({ vendorId: 's1' }));
  });

  it('no places: no count line, the dishes alone; no dishes: no heading', () => {
    expect(engineSearchRows([], [dish(1)]).map((r) => r.kind)).toEqual(['dishes', 'dish']);
    expect(engineSearchRows([place(1)], []).map((r) => r.kind)).toEqual(['count', 'place']);
    // A place and a dish can share an id (two tables): their keys never collide.
    const rows = engineSearchRows([{ id: 'x' }], [{ id: 'x' }]);
    expect(rows.map(searchRowKey)).toEqual(['count', 'place:x', 'dishes', 'dish:x']);
  });
});
