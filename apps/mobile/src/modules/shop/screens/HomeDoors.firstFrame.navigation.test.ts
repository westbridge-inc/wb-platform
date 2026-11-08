/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED D · owner 7 Nov: "you tap the Services tab or Taxi or Groceries —
// it LOADS, then goes to it"] The REAL Services, Search (the Food and Groceries
// tiles' door) and Favourites screens over the REAL hooks and a real query
// client, the API answering by hand. For each door, the FIRST frame:
//   (1) read ahead by Home (hooks/homeDoors readDoor): the content itself;
//   (2) nothing read yet: the content's shape (kit/skeletons), never a
//       full-screen spinner, never "nothing here", nothing to press;
//   (3) the read failed: the failure, with Try again — never an empty list.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  getVendors: vi.fn(),
  getFavorites: vi.fn(),
  getHome: vi.fn(),
  get: vi.fn(),
  route: { params: {} as Record<string, unknown> },
  navigate: vi.fn(),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const View = (p: any) => h('div', { 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole }, p.children);
  const Pressable = (p: any) => h('div', { role: 'button', 'aria-label': p.accessibilityLabel, onClick: p.onPress }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  const FlatList = (p: any) => h('div', null,
    p.ListHeaderComponent ?? null,
    (p.data ?? []).map((item: any, index: number) => h(R.Fragment, { key: p.keyExtractor ? p.keyExtractor(item, index) : index }, p.renderItem({ item, index }))));
  return {
    View, ScrollView: View, FlatList, Pressable,
    TextInput: (p: any) => h('input', { 'aria-label': p.accessibilityLabel, defaultValue: p.value }),
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
    Platform: { OS: 'android' },
  };
});
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: fx.navigate, goBack: vi.fn() }),
  useRoute: () => fx.route,
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('../../../lib/images', () => ({ storePhotoUrl: () => null, itemPhoto: () => null, vendorPhoto: () => null }));
vi.mock('../../../kit/action-sheet', () => ({ ActionSheet: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  const T = (p: any) => h('span', null, p.children);
  const button = (p: any) => h('button', { type: 'button', disabled: !!(p.disabled || p.loading), onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label);
  return {
    Screen: Box, Card: Box, DecorativeIcon: Box, T, PopupTitle: T,
    Header: (p: any) => h('header', null, p.title, p.right),
    // A full-screen spinner, were any door to draw one.
    LoadingBlock: () => h('p', null, 'SPINNER'),
    EmptyState: (p: any) => h('div', null, p.title, p.actionLabel ? button({ label: p.actionLabel, onPress: p.onAction }) : null),
    ErrorState: (p: any) => h('div', null, 'We couldn’t load this', button({ label: 'Try again', onPress: p.onRetry })),
    LinkText: button, PillButton: button, Chip: button,
    FoodCard: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.name),
    Photo: () => null, Money: () => null, RatingMeta: () => null, Pictogram: () => null, IconChip: () => null,
    TonePill: (p: any) => h('span', null, p.label), SectionHeader: (p: any) => h('h2', null, p.title),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    CartBar: () => null, useCartBarClearance: () => 0,
  };
});
vi.mock('../../../services/api', () => ({
  customerApi: { getVendors: fx.getVendors, getFavorites: fx.getFavorites, getHome: fx.getHome, searchSuggestions: vi.fn(), searchTrending: vi.fn(), search: vi.fn() },
  rideApi: {}, marketApi: {}, discoveryApi: {}, moderationApi: {},
  api: { get: fx.get },
  API_URL: 'https://api.test',
}));
vi.mock('../../../hooks', () => ({
  useServiceProviders: () => ({ data: undefined, isFetching: false, isError: false, refetch: vi.fn() }),
  useRequestJob: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}));
vi.mock('../../services/serviceProviderEntry', () => ({ enterServiceProvider: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../../../lib/rideRequestAttemptStore', () => ({ rideRequestAttempt: {} }));
vi.mock('../../../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn(), checkoutFailureOutcome: vi.fn(), settleUnresolvedIntent: vi.fn() }));
vi.mock('../../../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, promptLogin: () => undefined, adEventScopeId: 'scope', sessionGeneration: 1, user: { id: 'customer-1' } };
  return {
    useAuthStore: Object.assign((select?: (s: typeof state) => unknown) => (select ? select(state) : state), { getState: () => state }),
    getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: vi.fn(), AuthSessionBoundaryError: class extends Error {},
  };
});
vi.mock('../../../stores/appStore', () => ({ useAppStore: () => ({ recentSearches: [], pushSearch: vi.fn(), clearSearches: vi.fn() }) }));
vi.mock('../../../stores/locationStore', () => {
  const place = { latitude: 6.8, longitude: -58.16, status: 'granted' };
  return { useLocationStore: Object.assign((select?: (s: typeof place) => unknown) => (select ? select(place) : place), { getState: () => place }) };
});
vi.mock('../../../lib/deviceLocation', () => ({
  grantedLocationFix: (latitude: number | null, longitude: number | null, status: string) =>
    (status === 'granted' && latitude != null && longitude != null ? { latitude, longitude } : null),
}));

import { readDoor } from '../../../hooks/homeDoors';
import { ServicesScreen } from '../../services/screens/ServicesScreen';
import { SearchScreen } from './SearchScreen';
import { FavoritesScreen } from './FavoritesScreen';

const HERE = { latitude: 6.8, longitude: -58.16 };
const DOORS = { signedIn: true, here: HERE, marketVisible: false };
const CATALOG = { version: 1, categories: [{ id: 'plumber', label: 'Plumber', group: 'HOME_AND_TRADES', modes: ['QUOTE_JOB'], quoteRequestsEnabled: true }] };
const STORES = [{ id: 'store-1', name: 'Shanta’s Roti Shop', isCurrentlyOpen: true }];
const answer = (data: unknown) => ({ data: { data } });
const never = () => new Promise(() => undefined);

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const text = () => host.textContent ?? '';
const skeleton = () => host.querySelector('[data-testid="door-skeleton"]');
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };

/** ONE render, the screen's first frame: no read is let land after it. */
async function firstFrame(screen: React.ComponentType<any>) {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(screen, { navigation: { navigate: fx.navigate } }))));
}

beforeEach(() => {
  vi.clearAllMocks();
  onlineManager.setOnline(true);
  fx.route = { params: {} };
  fx.getHome.mockImplementation(never);
  // retryDelay 0: the catalogue keeps its own one retry (services/useServiceCatalog), at once here.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('[APP-SPEED D] Services: the catalogue', () => {
  it('read ahead by Home: the first frame is the pills themselves (and the screen still re-reads behind them)', async () => {
    fx.get.mockResolvedValueOnce({ data: { data: CATALOG } });
    await readDoor(client, 'services', DOORS);
    fx.get.mockImplementation(never);
    await firstFrame(ServicesScreen);
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Plumber')).toBe(true);
    expect(skeleton()).toBeNull();
    expect(text()).not.toContain('SPINNER');
  });

  it('nothing read yet: the pills’ shape, no spinner, no "nothing here", nothing to press', async () => {
    fx.get.mockImplementation(never);
    await firstFrame(ServicesScreen);
    expect(skeleton()).toBeTruthy();
    expect(skeleton()?.getAttribute('aria-label')).toBe('Loading');
    expect(text()).not.toContain('SPINNER');
    expect(text()).not.toContain('Couldn’t load services');
    expect(skeleton()?.querySelector('button')).toBeNull();
    expect(text()).not.toContain('Send request');
  });

  it('the read failed: the failure with Try again, never an empty catalogue', async () => {
    fx.get.mockRejectedValue(new Error('network'));
    await firstFrame(ServicesScreen);
    await flush();
    expect(text()).toContain('Couldn’t load services');
    expect(skeleton()).toBeNull();
    expect(text()).not.toContain('What needs doing?');
  });
});

describe('[APP-SPEED D] Food and Groceries: Search’s store list', () => {
  for (const [door, type] of [['food', 'RESTAURANT'], ['groceries', 'SUPERMARKET']] as const) {
    it(`${door}: read ahead by Home, the first frame is the stores themselves`, async () => {
      fx.getVendors.mockResolvedValueOnce(answer(STORES));
      await readDoor(client, door, DOORS);
      fx.getVendors.mockImplementation(never);
      fx.route = { params: { type } };
      await firstFrame(SearchScreen);
      expect(text()).toContain('Shanta’s Roti Shop');
      expect(text()).toContain('1 place');
      expect(skeleton()).toBeNull();
      expect(fx.getVendors).toHaveBeenLastCalledWith({ type, lat: '6.8', lng: '-58.16' });
    });
  }

  it('nothing read yet: the rows’ shape, never a spinner or "No matches"', async () => {
    fx.getVendors.mockImplementation(never);
    fx.route = { params: { type: 'SUPERMARKET' } };
    await firstFrame(SearchScreen);
    expect(skeleton()).toBeTruthy();
    expect(text()).not.toContain('SPINNER');
    expect(text()).not.toContain('No matches');
  });

  it('the read failed: the failure with Try again, never "No matches"', async () => {
    fx.getVendors.mockRejectedValue(new Error('network'));
    fx.route = { params: { type: 'RESTAURANT' } };
    await firstFrame(SearchScreen);
    await flush();
    expect(text()).toContain('We couldn’t load this');
    expect(text()).not.toContain('No matches');
    expect(skeleton()).toBeNull();
  });
});

describe('[APP-SPEED D] Favourites', () => {
  it('read ahead by Home: the first frame is the saved stores', async () => {
    fx.getFavorites.mockResolvedValueOnce(answer(STORES));
    await readDoor(client, 'favourites', DOORS);
    fx.getFavorites.mockImplementation(never);
    await firstFrame(FavoritesScreen);
    expect(text()).toContain('Shanta’s Roti Shop');
    expect(skeleton()).toBeNull();
  });

  it('nothing read yet: the cards’ shape; the read failed: the failure, never "Nothing saved yet"', async () => {
    fx.getFavorites.mockImplementation(never);
    await firstFrame(FavoritesScreen);
    expect(skeleton()).toBeTruthy();
    expect(text()).not.toContain('SPINNER');
    expect(text()).not.toContain('Nothing saved yet');

    await act(async () => root.unmount());
    client.clear();
    root = createRoot(host);
    fx.getFavorites.mockRejectedValue(new Error('network'));
    await firstFrame(FavoritesScreen);
    await flush();
    expect(text()).toContain('We couldn’t load this');
    expect(text()).not.toContain('Nothing saved yet');
  });
});
