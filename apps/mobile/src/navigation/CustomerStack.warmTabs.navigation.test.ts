/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED A · owner 7 Nov] The first tap on the Profile or Cart tab MOUNTED
// that screen (lazy tabs): every row was built at the tap, after a spinner.
// The customer tab bar now uses the business tabs' pattern (navigation/
// warmTabs.ts, #2383): once Home has painted and Swift is quiet, Profile then
// Cart mount hidden, one per quiet moment, and the first tap only shows them.
// Market stays lazy. The REAL CustomerStack in the real bottom-tab navigator;
// each tab screen is a probe that records its mount and when it is SHOWN.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  marketDepth: 'visible' as string,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
  mounted: [] as string[],
  shown: [] as string[],
  // A tab screen: records its mount, and every time it is SHOWN (focus), as a real "viewed" effect would.
  probe: (R: typeof import('react'), nav: typeof import('@react-navigation/native'), name: string) => function Probe() {
    R.useEffect(() => { fx.mounted.push(name); }, []);
    nav.useFocusEffect(R.useCallback(() => { fx.shown.push(name); }, []));
    return R.createElement('section', { 'data-tab': name, 'data-focused': String(nav.useIsFocused()) }, name);
  },
  probeModule: async (exportName: string, name: string) =>
    ({ [exportName]: fx.probe(await import('react'), await import('@react-navigation/native'), name) }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: View, Pressable: View,
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, AppState: { addEventListener: () => ({ remove() {} }) },
    Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock('@react-navigation/elements', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const SafeAreaProviderCompat = Object.assign(Box, { initialMetrics: { frame: { width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } } });
  return {
    SafeAreaProviderCompat, Screen: Box, Header: () => null, HeaderBackButton: () => null,
    HeaderBackContext: R.createContext(undefined), HeaderShownContext: R.createContext(false),
    HeaderHeightContext: R.createContext(0), useHeaderHeight: () => 0,
    getHeaderTitle: (_options: unknown, name: string) => name, getLabel: (options: any, fallback: string) => options.label ?? fallback,
    PlatformPressable: Box, Label: Box, Background: Box, Badge: () => null, MissingIcon: () => null,
    useFrameSize: () => ({ width: 390, height: 844 }), useLocale: () => ({ direction: 'ltr' }),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const R = await import('react');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return { SafeAreaInsetsContext: R.createContext(insets), useSafeAreaInsets: () => insets, SafeAreaProvider: ({ children }: any) => children };
});
vi.mock('react-native-screens', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { screensEnabled: () => false, Screen: Box, ScreenContainer: Box };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, font: fx.token, fontSize: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../kit', () => ({ TabGlyph: () => null }));
vi.mock('../hooks/customer', () => ({ useMarketDepth: () => ({ data: fx.marketDepth }) }));
vi.mock('../lib/homeReliability', () => ({ marketTabVisible: (depth: unknown) => depth === 'visible' }));
vi.mock('../modules/shop/screens/HomeScreen', () => fx.probeModule('HomeScreen', 'Home'));
vi.mock('../modules/shop/screens/RecommendedScreen', () => ({ RecommendedScreen: () => null }));
vi.mock('../modules/shop/screens/NearbyScreen', () => ({ NearbyScreen: () => null }));
vi.mock('../modules/shop/screens/SearchScreen', () => ({ SearchScreen: () => null }));
vi.mock('../modules/shop/screens/CategoryFeedScreen', () => ({ CategoryFeedScreen: () => null }));
vi.mock('../modules/shop/screens/CategoryGridScreen', () => ({ CategoryGridScreen: () => null }));
vi.mock('../modules/shop/screens/RestaurantScreen', () => ({ RestaurantScreen: () => null }));
vi.mock('../modules/shop/screens/MenuItemScreen', () => ({ MenuItemScreen: () => null }));
vi.mock('../modules/shop/screens/FavoritesScreen', () => ({ FavoritesScreen: () => null }));
vi.mock('../modules/shop/screens/ScanScreen', () => ({ ScanScreen: () => null }));
vi.mock('../modules/shop/screens/VendorReviewsScreen', () => ({ VendorReviewsScreen: () => null }));
vi.mock('../modules/cart/screens/CartScreen', () => fx.probeModule('CartScreen', 'Cart'));
vi.mock('../modules/orders/screens/OrdersHistoryScreen', () => ({ OrdersHistoryScreen: () => null }));
vi.mock('../modules/shop/screens/MarketScreen', () => fx.probeModule('MarketScreen', 'Market'));
vi.mock('../modules/orders/screens/DeliveryScreen', () => ({ DeliveryScreen: () => null }));
vi.mock('../modules/orders/screens/FeedbackScreen', () => ({ FeedbackScreen: () => null }));
vi.mock('../modules/chat/screens/ChatListScreen', () => ({ ChatListScreen: () => null }));
vi.mock('../modules/chat/screens/ConversationScreen', () => ({ ConversationScreen: () => null }));
vi.mock('../modules/profile/screens/ProfileScreen', () => fx.probeModule('ProfileScreen', 'Profile'));
vi.mock('../modules/profile/screens/PersonalDataScreen', () => ({ PersonalDataScreen: () => null }));
vi.mock('../modules/profile/screens/AccountHandoverScreen', () => ({ AccountHandoverScreen: () => null })); // [COMPANY-DOCS Part 3] its papers list carries a camera picker
vi.mock('../modules/profile/screens/NotificationsScreen', () => ({ NotificationsScreen: () => null }));
vi.mock('../modules/profile/screens/InviteFriendsScreen', () => ({ InviteFriendsScreen: () => null }));
vi.mock('../modules/profile/screens/FaqScreen', () => ({ FaqScreen: () => null }));
vi.mock('../modules/profile/screens/ContactUsScreen', () => ({ ContactUsScreen: () => null }));
vi.mock('../modules/profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));
vi.mock('../modules/profile/screens/AddressesScreen', () => ({ AddressesScreen: () => null }));
vi.mock('../modules/profile/screens/AddAddressScreen', () => ({ AddAddressScreen: () => null }));
vi.mock('../modules/safety/screens/EmergencyContactsScreen', () => ({ EmergencyContactsScreen: () => null }));
vi.mock('../modules/safety/screens/BlockedUsersScreen', () => ({ BlockedUsersScreen: () => null }));
vi.mock('../modules/profile/screens/LocationPickerScreen', () => ({ LocationPickerScreen: () => null }));
vi.mock('../modules/movement/screens/TaxiScreen', () => ({ TaxiScreen: () => null }));
vi.mock('../modules/movement/screens/RideDetailScreen', () => ({ RideDetailScreen: () => null }));
vi.mock('../modules/movement/screens/CourierScreen', () => ({ CourierScreen: () => null }));
vi.mock('../modules/movement/screens/DestinationSearchScreen', () => ({ DestinationSearchScreen: () => null }));
vi.mock('../modules/movement/screens/PinConfirmScreen', () => ({ PinConfirmScreen: () => null }));
vi.mock('../modules/services/screens/ServicesScreen', () => ({ ServicesScreen: () => null }));
vi.mock('../modules/services/screens/ServiceJobsScreen', () => ({ ServiceJobsScreen: () => null }));
vi.mock('../modules/services/screens/ServiceProviderScreen', () => ({ ServiceProviderScreen: () => null }));
vi.mock('../modules/services/screens/ProviderWeeklyFeeScreen', () => ({ ProviderWeeklyFeeScreen: () => null }));
vi.mock('../modules/services/screens/ProBookingScreen', () => ({ ProBookingScreen: () => null }));
vi.mock('../modules/services/screens/ProBookableScreen', () => ({ ProBookableScreen: () => null }));
vi.mock('../screens/auth/SelfieCaptureScreen', () => ({ SelfieCaptureScreen: () => null })); // [owner 9 Nov (A)] the pro's ProSelfie

import { WARM_TAB_QUIET_MS } from './warmTabs';
import { CustomerStack } from './CustomerStack';

const navigation = createNavigationContainerRef<Record<string, object | undefined>>();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fx.mounted.length = 0; fx.shown.length = 0; fx.marketDepth = 'visible';
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); vi.useRealTimers(); });

async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(NavigationContainer<Record<string, object | undefined>>, {
      ref: navigation, linking: { enabled: false, prefixes: [] }, children: React.createElement(CustomerStack),
    }))));
  expect(navigation.isReady()).toBe(true);
}
async function wait(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function quiet(times: number) { for (let i = 0; i < times; i++) await wait(WARM_TAB_QUIET_MS + 10); }

describe('[APP-SPEED A] Profile and Cart are drawn before the first tap', () => {
  it('first paint is Home alone; once Swift is quiet, Profile then Cart mount hidden, unshown; Market stays lazy', async () => {
    await mount();
    expect(fx.mounted, 'the first paint is Home alone').toEqual(['Home']);
    await wait(WARM_TAB_QUIET_MS - 50);
    expect(fx.mounted, 'nothing before Swift has been quiet a moment').toEqual(['Home']);
    await wait(60);
    expect(fx.mounted).toEqual(['Home', 'Profile']);
    await quiet(3);
    expect(fx.mounted).toEqual(['Home', 'Profile', 'Cart']);
    expect(fx.shown, 'a tab drawn ahead is never SHOWN (no focus effect, no "viewed")').toEqual(['Home']);
    expect(navigation.getCurrentRoute()?.name).toBe('Home');

    // The tap only shows the drawn tab: no second mount.
    await act(async () => navigation.navigate('Tabs', { screen: 'Cart' }));
    expect(fx.mounted.filter((n) => n === 'Cart')).toHaveLength(1);
    expect(fx.shown.at(-1)).toBe('Cart');
    expect(host.querySelector('[data-tab="Cart"]')?.getAttribute('data-focused')).toBe('true');
    // Market was never drawn ahead; its first tap mounts it, as before.
    expect(fx.mounted).not.toContain('Market');
    await act(async () => navigation.navigate('Tabs', { screen: 'Market' }));
    expect(fx.mounted.at(-1)).toBe('Market');
  });

  it('waits while a read is on its way (Home’s feed first)', async () => {
    let land!: () => void;
    void client.fetchQuery({ queryKey: ['customer', 'home'], queryFn: () => new Promise((resolve) => { land = () => resolve({}); }) });
    await mount();
    await quiet(4);
    expect(fx.mounted, 'nothing mounts behind a read still loading').toEqual(['Home']);
    await act(async () => land());
    await wait(WARM_TAB_QUIET_MS + 10);
    expect(fx.mounted).toEqual(['Home', 'Profile']);
  });
});
