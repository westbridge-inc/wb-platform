/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] Pizza-grade options in the store's item editor: a group that SETS THE PRICE
// (Size: the item's own price becomes "From $X (lowest size)", read-only, and an edit never sends a price), a
// HALF-AND-HALF group with the store's half price rule, a choice that OPENS A FOLLOW-UP GROUP of the item (one level),
// and a group SHARED from the option library ("Used by N items", edited in the library, Remove = off this item only).
// The server refuses a broken rule in its own words (MENU_OPTIONS_RULE): the editor shows them. The REAL
// VendorItemEditorScreen in a real NavigationContainer + native-stack (the harness of
// VendorItemEditorScreen.newItemOptions.navigation.test.ts); the network is a stand-in.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  save: vi.fn(),
  addGroup: vi.fn(),
  addOption: vi.fn(),
  delGroup: vi.fn(),
  write: vi.fn(),
  api: {
    updateOption: vi.fn((id: string, body: unknown) => Promise.resolve({ data: { data: { id, ...(body as object) } } })),
    updateOptionGroup: vi.fn(),
    attachModifierGroup: vi.fn(),
    categories: vi.fn(),
  },
  library: [] as unknown[],
  store: { vendorType: 'RESTAURANT' } as Record<string, unknown>,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  const Pressable = ({ children, onPress, accessibilityLabel }: any) =>
    R.createElement('button', { type: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, typeof children === 'function' ? children({ pressed: false }) : children);
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: View, Pressable,
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

vi.mock('expo-image', () => ({ Image: () => null }));
// [MASTER-025] the stock row mints its adjustment key with expo-crypto (native).
vi.mock('expo-crypto', () => ({ randomUUID: () => 'stock-adjust-key' }));
vi.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestMediaLibraryPermissionsAsync: vi.fn(), requestCameraPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(), launchCameraAsync: vi.fn(),
}));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }) }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  const input = (p: any) => h('input', { 'aria-label': p.placeholder, value: p.value, onChange: (e: any) => p.onChangeText(e.target.value) });
  const press = (p: any) => h('button', { type: 'button', disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.label);
  return {
    Card: Box, Screen: Box, IconChip: () => null, PhotoDrop: () => null, Segmented: () => null,
    T: (p: any) => h('span', { 'data-testid': p.testID }, p.children), PopupTitle: Box,
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    Chip: (p: any) => h('button', { type: 'button', 'aria-pressed': p.selected ? 'true' : 'false', onClick: p.onPress }, p.label),
    LabeledInput: input, LinkText: press, PillButton: press,
    ConfirmDialog: () => null,
  };
});
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (go: () => void) => { setTimeout(go, 0); } }));
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../shared', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    DAY_LABELS: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], GUTTER: 16,
    InlineInput: (p: any) => h('input', { 'aria-label': p.placeholder, value: p.value, onChange: (e: any) => p.onChangeText(e.target.value) }),
    SubHeader: (p: any) => h('header', null, h('button', { type: 'button', onClick: () => p.navigation.goBack() }, 'Back'), p.title),
  };
});
vi.mock('../../../services/api', () => ({ vendorApi: fx.api }));
vi.mock('../../../hooks/storeVat', () => ({ useStoreVat: () => ({ data: undefined }) }));
vi.mock('../../../hooks/useVendorMutation', () => ({ useVendorMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/menuOptions', () => ({
  useOptionLibrary: () => ({ data: fx.library, isLoading: false }),
  // The real sender runs the request and answers its `data` (hooks/menuOptions); a refusal rejects.
  useMenuOptionsWrite: () => ({ mutateAsync: fx.write, isPending: false }),
}));
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useVendorProfile: () => ({ store: fx.store }),
    useSaveItem: () => ({ mutateAsync: fx.save, isPending: false, isError: false, error: null }),
    useUploadItemImage: idle, useDeleteOption: idle,
    useDeleteOptionGroup: () => ({ mutate: fx.delGroup, mutateAsync: vi.fn(), isPending: false }),
    useAddOptionGroup: () => ({ mutate: vi.fn(), mutateAsync: fx.addGroup, isPending: false }),
    useAddOption: () => ({ mutate: vi.fn(), mutateAsync: fx.addOption, isPending: false }),
  };
});
vi.mock('../../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionSnapshot: () => ({ userId: 'owner', generation: 1 }),
  requireAuthSessionForPrincipal: (session: unknown) => session,
  useAuthStore: (select: (state: unknown) => unknown) => select({ user: { selfieCapturedAt: '2026-11-01T00:00:00.000Z' } }),
}));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: 'store-A' }) } }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (select: (s: unknown) => unknown) => select({ previewType: null }) }));
vi.mock('../../../lib/images', () => ({ mediaUrl: () => undefined, isKeptPhoto: () => false, storePhotoUrl: () => null, HERO_PHOTO_WIDTH: 1280 }));

import { VendorItemEditorScreen } from './VendorItemEditorScreen';

const nav = createNavigationContainerRef<Record<string, object | undefined>>();
const Stack = createNativeStackNavigator();
const h = React.createElement;
const VendorMenu = () => h('p', null, 'menu list');
const VendorOptionLibrary = () => h('p', null, 'option library');
const CATEGORIES = [{ id: 'mains', name: 'Mains' }];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  fx.store = { vendorType: 'RESTAURANT' };
  fx.library = [];
  fx.save.mockResolvedValue({ id: 'item-1' });
  fx.write.mockImplementation(async (send: () => Promise<any>) => (await send())?.data?.data);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const stack = () => nav.getRootState().routes.map((r) => r.name);
const buttons = (label: string) => Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === label);
const shown = (text: string) => Array.from(host.querySelectorAll('span')).some((s) => s.textContent === text);
async function tap(label: string, nth = 0) {
  const el = buttons(label)[nth];
  expect(el, label).toBeTruthy();
  await act(async () => { el!.click(); });
  await settle();
}
async function type(placeholder: string, value: string, nth = 0) {
  const el = host.querySelectorAll<HTMLInputElement>(`input[aria-label="${placeholder}"]`)[nth]!;
  expect(el, placeholder).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); });
}
/** A choice typed into a group's row (the nth group), then that row's + . */
async function addChoice(name: string, price: string, pricePlaceholder: string, nth = 0, priceNth = 0) {
  await type('Choice (e.g. Large)', name, nth);
  await type(pricePlaceholder, price, priceNth);
  const plus = host.querySelectorAll('input[aria-label="Choice (e.g. Large)"]')[nth]!.parentElement!.querySelector('button')!;
  await act(async () => { plus.click(); });
  await settle();
}
async function open(params: Record<string, unknown>) {
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Stack.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Stack.Screen, { key: 'VendorMenu', name: 'VendorMenu', component: VendorMenu }),
        h(Stack.Screen, { key: 'VendorItemEditor', name: 'VendorItemEditor', component: VendorItemEditorScreen }),
        h(Stack.Screen, { key: 'VendorOptionLibrary', name: 'VendorOptionLibrary', component: VendorOptionLibrary }),
      ],
    }))));
  await act(async () => nav.navigate('VendorItemEditor', { categories: CATEGORIES, ...params }));
  await settle();
}

const PIZZA = {
  id: 'item-pizza', name: 'Pizza', categoryId: 'mains', basePrice: 1800, isAvailable: true,
  optionGroups: [
    { id: 'g-size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: true, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-s', name: 'Small', additionalPrice: 1800 }, { id: 'o-l', name: 'Large', additionalPrice: 3200 }] },
    { id: 'g-crust', name: 'Crust', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: false, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-thin', name: 'Thin', additionalPrice: 0, followUpGroupId: null }, { id: 'o-stuffed', name: 'Stuffed crust', additionalPrice: 300, followUpGroupId: null }] },
    { id: 'g-cheese', name: 'Cheese', isRequired: false, minSelect: 0, maxSelect: 1, setsPrice: false, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-ched', name: 'Cheddar', additionalPrice: 0, followUpGroupId: null }] },
    { id: 'copy-top', name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 10, setsPrice: false, allowHalves: true, halfPricePercent: 50, libraryGroupId: 'lib-top',
      options: [{ id: 'c-pep', name: 'Pepperoni', additionalPrice: 400, libraryOptionId: 'lo-pep' }] },
  ],
};

describe('[MENU-OPTIONS] a new pizza: size sets the price, toppings are half-and-half', () => {
  it('the item\'s price follows its sizes (read-only "From"), and the groups go with their rules in the one create request', async () => {
    await open({});
    await type('Item name', 'Pizza');
    await type('New group (e.g. Size, Toppings)', 'Size');
    await tap('Sets the price');
    expect(buttons('Required'), 'a group that sets the price is always "pick one": no Required / Multiple picks').toHaveLength(0);
    await tap('Add option group');
    expect(shown('Sets the price · pick one')).toBe(true);
    await addChoice('Small', '1800', 'Price');
    await addChoice('Large', '3200', 'Price');
    expect(shown('Price $3,200'), 'a size choice is the whole price, not "+"').toBe(true);
    expect(host.querySelector('input[aria-label="Price (GYD)"]'), 'no price box of its own once it has sizes').toBeNull();
    expect(shown('From $1,800 (lowest size)')).toBe(true);

    await type('New group (e.g. Size, Toppings)', 'Toppings');
    await tap('Multiple picks');
    expect(buttons('Sets the price'), 'only one group per item sets the price: the new group is not offered it').toHaveLength(1);
    await tap('Half-and-half'); // the size group offers none: a group that sets the price is never half-and-half
    await tap('% of the choice price');
    await type('Half costs (%)', '60');
    await tap('Set');
    await tap('Add option group');
    expect(shown('Optional · up to 10 · Half-and-half (a half costs 60% of the choice price)')).toBe(true);
    await addChoice('Pepperoni', '400', '+GYD', 1, 0); // the size row's box says Price

    await tap('Add item');
    expect(fx.save).toHaveBeenCalledTimes(1);
    const sent = fx.save.mock.calls[0]![0].data;
    expect(sent.basePrice, 'the lowest size (the server keeps it so)').toBe(1800);
    expect(sent.optionGroups).toEqual([
      { name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: true, options: [{ name: 'Small', additionalPrice: 1800 }, { name: 'Large', additionalPrice: 3200 }] },
      { name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 10, allowHalves: true, halfPricePercent: 60, options: [{ name: 'Pepperoni', additionalPrice: 400 }] },
    ]);
    expect(stack()).toEqual(['VendorMenu']);
  });
});

describe('[MENU-OPTIONS] a saved pizza', () => {
  it('an edit of a sized item never sends a price (the server keeps the lowest size)', async () => {
    await open({ item: PIZZA });
    expect(shown('From $1,800 (lowest size)')).toBe(true);
    await type('Item name', 'Pizza pie');
    await tap('Save changes');
    expect(fx.save).toHaveBeenCalledTimes(1);
    const sent = fx.save.mock.calls[0]![0].data;
    expect(sent).not.toHaveProperty('basePrice');
    expect(sent).not.toHaveProperty('vatListedPrice');
  });

  it('a choice opens a follow-up group of the same item: never the size, never a group that opens others', async () => {
    await open({ item: PIZZA });
    await tap('Opens follow-up group', 3); // Stuffed crust (Small, Large, Thin come first)
    const offered = Array.from(host.querySelectorAll('[role="dialog"] button')).map((b) => b.textContent);
    expect(offered).toEqual(['Cheese', 'Toppings', 'Opens nothing', 'Cancel']);
    await tap('Cheese');
    expect(fx.api.updateOption).toHaveBeenCalledWith('o-stuffed', { followUpGroupId: 'g-cheese' });
    expect(buttons('Opens: Cheese'), 'the choice now names the group it opens').toHaveLength(1);
    expect(shown('Follow-up group: shown when its choice is picked.')).toBe(true);
  });

  it('the server\'s refusal of a broken rule is shown in its own words', async () => {
    fx.write.mockRejectedValueOnce({ response: { data: { error: { code: 'MENU_OPTIONS_RULE', message: 'An item can have only one group that sets the price (like Size).' } } } });
    await open({ item: PIZZA });
    await tap('Opens follow-up group', 3);
    await tap('Toppings');
    expect(shown('An item can have only one group that sets the price (like Size).')).toBe(true);
  });

  it('a shared group says how many items use it, is edited in the library, and Remove takes it off this item only', async () => {
    fx.library = [{ id: 'lib-top', name: 'Toppings', usedByItemCount: 4, isFollowUp: false, usedByItems: [], options: [] }];
    await open({ item: PIZZA });
    expect(shown('Shared · Used by 4 items')).toBe(true);
    expect(shown('Changes apply to all 4 items when you edit it.')).toBe(true);
    expect(host.querySelectorAll('input[aria-label="Choice (e.g. Large)"]'), 'no choice is typed onto a shared copy').toHaveLength(3);
    await tap('Edit shared group');
    expect(stack()).toEqual(['VendorMenu', 'VendorItemEditor', 'VendorOptionLibrary']);
    expect(nav.getCurrentRoute()?.params).toEqual({ groupId: 'lib-top' });
  });

  it('Remove on a shared group asks "Remove from this item?" and sends the item\'s copy only', async () => {
    fx.library = [{ id: 'lib-top', name: 'Toppings', usedByItemCount: 4, isFollowUp: false, usedByItems: [], options: [] }];
    await open({ item: PIZZA });
    const trash = host.querySelector('button[aria-label="Remove Toppings"]') as HTMLButtonElement;
    await act(async () => { trash.click(); });
    await settle();
    expect(shown('The shared group stays in your option library and on the other items that use it.')).toBe(true);
    await tap('Remove');
    expect(fx.delGroup).toHaveBeenCalledWith({ id: 'copy-top', authSession: { userId: 'owner', generation: 1 } }, expect.anything());
  });

  it('"Add from option library" attaches a group the item does not have yet', async () => {
    fx.library = [
      { id: 'lib-top', name: 'Toppings', usedByItemCount: 4, isFollowUp: false, usedByItems: [], options: [] },
      { id: 'lib-dips', name: 'Dips', usedByItemCount: 0, isFollowUp: false, usedByItems: [], options: [] },
      { id: 'lib-sauce', name: 'Sauce', usedByItemCount: 1, isFollowUp: true, usedByItems: [], options: [] },
    ];
    fx.api.attachModifierGroup.mockResolvedValue({ data: { data: { attached: ['item-pizza'], already: [] } } });
    fx.api.categories.mockResolvedValue({ data: { data: [{ id: 'mains', items: [{ ...PIZZA, optionGroups: [...PIZZA.optionGroups, { id: 'copy-dips', name: 'Dips', libraryGroupId: 'lib-dips', options: [] }] }] }] } });
    await open({ item: PIZZA });
    await tap('Add from option library');
    const offered = Array.from(host.querySelectorAll('[role="dialog"] button')).map((b) => b.textContent);
    expect(offered).toContain('Dips · Used by 0 items');
    expect(offered.some((t) => t?.startsWith('Toppings')), 'already on the item').toBe(false);
    expect(offered.some((t) => t?.startsWith('Sauce')), 'a follow-up group comes with its opener').toBe(false);
    await tap('Dips · Used by 0 items');
    expect(fx.api.attachModifierGroup).toHaveBeenCalledWith('lib-dips', ['item-pizza']);
    expect(shown('Dips'), 'the item\'s groups are read again').toBe(true);
  });
});
