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
vi.mock('../../../hooks/menuOptions', async (actual) => ({
  // The real menuWriteScope: who and which store a write is for.
  ...(await actual<typeof import('../../../hooks/menuOptions')>()),
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
    // [REVIEW-MENU-A S4-11] Pinned to the account that made it, like every option write of the editor.
    expect(fx.api.updateOption).toHaveBeenCalledWith('o-stuffed', { followUpGroupId: 'g-cheese' }, { userId: 'owner', generation: 1 });
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
    // [REVIEW-MENU-A S4-11] The account and the store the tap was made in.
    expect(fx.api.attachModifierGroup).toHaveBeenCalledWith('lib-dips', ['item-pizza'], { userId: 'owner', generation: 1 }, 'store-A');
    expect(shown('Dips'), 'the item\'s groups are read again').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [REVIEW-MENU-B S2-1 · S3-2 · S3-3 · S3-5] An existing restaurant's "Size" is add-ons (Small +0 / Large +500 on a
// 2,000 item). Switching it to "Sets the price" at one tap made the item cost $0 (a Small for nothing): the switch now
// shows the converted prices first and sends them with it, in one request. A rule chip sends only that rule (a group's
// own "pick 2 to 3" survives), a typed price is read ("1,500" = 1500, never a blank $0 size), and a new size group is
// created with its first size (the server refuses a size group with none).
// ---------------------------------------------------------------------------
const OWNER = { userId: 'owner', generation: 1 };
const CURRY = {
  id: 'item-curry', name: 'Curry', categoryId: 'mains', basePrice: 2000, isAvailable: true,
  optionGroups: [
    { id: 'g-addon-size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: false, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-small', name: 'Small', additionalPrice: 0 }, { id: 'o-large', name: 'Large', additionalPrice: 500 }] },
    { id: 'g-sauces', name: 'Sauces', isRequired: true, minSelect: 2, maxSelect: 3, setsPrice: false, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-bbq', name: 'BBQ', additionalPrice: 100 }] },
  ],
};
const answerGroup = (id: string, body: any) => Promise.resolve({ data: { data: { ...CURRY.optionGroups.find((g) => g.id === id), ...body } } });

describe('[REVIEW-MENU-B] switching "Sets the price" on a group that already has choices', () => {
  it('ON: nothing is saved at the tap; the confirm shows each size\'s full price (item price + add-on) and sends them with the switch', async () => {
    fx.api.updateOptionGroup.mockImplementation((id: string, body: any) => answerGroup(id, { ...body, setsPrice: true, options: [
      { id: 'o-small', name: 'Small', additionalPrice: 2000 }, { id: 'o-large', name: 'Large', additionalPrice: 2500 }] }));
    await open({ item: CURRY });
    await tap('Sets the price', 0);
    expect(fx.api.updateOptionGroup, 'no save at the tap').not.toHaveBeenCalled();
    expect(shown('Small $2,000 / Large $2,500 — the item’s price becomes its sizes’ prices.')).toBe(true);
    await tap('Save these prices');
    expect(fx.api.updateOptionGroup).toHaveBeenCalledTimes(1);
    expect(fx.api.updateOptionGroup).toHaveBeenCalledWith('g-addon-size', { setsPrice: true, prices: [{ id: 'o-small', price: 2000 }, { id: 'o-large', price: 2500 }] }, OWNER);
    expect(shown('Price $2,500'), 'the sizes now read as prices').toBe(true);
  });

  it('a size left blank (or 0) in the confirm is refused there, and nothing is sent', async () => {
    await open({ item: CURRY });
    await tap('Sets the price', 0);
    const box = host.querySelectorAll<HTMLInputElement>('[role="dialog"] input')[0]!;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')!.set!;
    await act(async () => { setter.call(box, ''); box.dispatchEvent(new window.Event('input', { bubbles: true })); });
    await tap('Save these prices');
    expect(shown('Small: Type this size’s full price (more than 0).')).toBe(true);
    expect(fx.api.updateOptionGroup).not.toHaveBeenCalled();
  });

  it('OFF: each choice becomes its price above the smallest size, confirmed and sent with the switch', async () => {
    fx.api.updateOptionGroup.mockImplementation((id: string, body: any) => Promise.resolve({ data: { data: { ...PIZZA.optionGroups[0], ...body, setsPrice: false } } }));
    await open({ item: PIZZA });
    await tap('Sets the price', 0);
    expect(fx.api.updateOptionGroup).not.toHaveBeenCalled();
    expect(shown('Small +$0 / Large +$1,400 — the item keeps its smallest size as its price; these are added on top.')).toBe(true);
    await tap('Save these prices');
    expect(fx.api.updateOptionGroup).toHaveBeenCalledWith('g-size', { setsPrice: false, prices: [{ id: 'o-s', price: 0 }, { id: 'o-l', price: 1400 }] }, OWNER);
  });

  it('a NEW item: the sizes start from the price typed in the form, and go with the item in its one create request', async () => {
    await open({});
    await type('Item name', 'Curry');
    await type('Price (GYD)', '2,000');
    await type('New group (e.g. Size, Toppings)', 'Size');
    await tap('Add option group');
    await addChoice('Small', '0', '+GYD');
    await addChoice('Large', '500', '+GYD');
    await tap('Sets the price', 0);
    expect(shown('Small $2,000 / Large $2,500 — the item’s price becomes its sizes’ prices.')).toBe(true);
    await tap('Save these prices');
    await tap('Add item');
    const sent = fx.save.mock.calls[0]![0].data;
    expect(sent.optionGroups).toEqual([
      { name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: true, options: [{ name: 'Small', additionalPrice: 2000 }, { name: 'Large', additionalPrice: 2500 }] },
    ]);
  });

  it('Cancel leaves the group as it was', async () => {
    await open({ item: CURRY });
    await tap('Sets the price', 0);
    await tap('Cancel');
    expect(fx.api.updateOptionGroup).not.toHaveBeenCalled();
    expect(shown('Required · pick one')).toBe(true);
  });
});

describe('[REVIEW-MENU-B S3-2] a rule chip sends only that rule', () => {
  it('Half-and-half on a "pick 2 to 3" group keeps its limits', async () => {
    fx.api.updateOptionGroup.mockImplementation((id: string, body: any) => answerGroup(id, body));
    await open({ item: CURRY });
    await tap('Half-and-half', 1);
    expect(fx.api.updateOptionGroup).toHaveBeenCalledWith('g-sauces', { allowHalves: true }, OWNER);
  });

  it('"% of the choice price" saves nothing until the store sets its percent', async () => {
    fx.api.updateOptionGroup.mockImplementation((id: string, body: any) => Promise.resolve({ data: { data: { ...PIZZA.optionGroups[1], ...body } } }));
    const halves = { ...PIZZA.optionGroups[1], id: 'g-half', name: 'Extras', allowHalves: true, halfPricePercent: 100, options: [{ id: 'o-x', name: 'Olives', additionalPrice: 100 }] };
    await open({ item: { ...PIZZA, optionGroups: [halves] } });
    await tap('% of the choice price');
    expect(fx.api.updateOptionGroup, 'no 50% nobody chose').not.toHaveBeenCalled();
    await type('Half costs (%)', '60');
    await tap('Set');
    expect(fx.api.updateOptionGroup).toHaveBeenCalledWith('g-half', { halfPricePercent: 60 }, OWNER);
  });
});

describe('[REVIEW-MENU-B S3-3] a typed price is read, never guessed', () => {
  it('a size typed "1,500" is 1500; a size left blank is refused (never a $0 pizza)', async () => {
    fx.addOption.mockResolvedValue({ id: 'o-xl', name: 'XL', additionalPrice: 1500 });
    await open({ item: PIZZA });
    await addChoice('XL', '', 'Price');
    expect(shown('Type this size’s full price (more than 0).')).toBe(true);
    expect(fx.addOption).not.toHaveBeenCalled();
    await addChoice('XL', '1,500', 'Price');
    expect(fx.addOption).toHaveBeenCalledWith({ groupId: 'g-size', data: { name: 'XL', additionalPrice: 1500 }, authSession: OWNER });
  });

  it('a mistyped add-on is refused; a blank add-on is free, as always', async () => {
    fx.addOption.mockResolvedValue({ id: 'o-y', name: 'Garlic', additionalPrice: 0 });
    await open({ item: PIZZA });
    await addChoice('Garlic', '1.5O', '+GYD', 1, 0); // the Crust row (the size row's box says Price)
    expect(shown('Type the price in whole dollars, like 1500.')).toBe(true);
    expect(fx.addOption).not.toHaveBeenCalled();
  });
});

describe('[REVIEW-MENU-B S2-1] a new size group comes with its first size', () => {
  it('"Sets the price" asks for the first size and its full price, and sends them with the group', async () => {
    fx.addGroup.mockResolvedValue({ id: 'g-new', name: 'Size', setsPrice: true, isRequired: true, minSelect: 1, maxSelect: 1, options: [{ id: 'o-r', name: 'Regular', additionalPrice: 1200 }] });
    await open({ item: { ...PIZZA, optionGroups: [PIZZA.optionGroups[2]] } });
    await type('New group (e.g. Size, Toppings)', 'Size');
    await tap('Sets the price', 1); // the new group's chip (the saved Cheese group's comes first)
    await tap('Add option group');
    expect(shown('Add the first size (like Small) with its full price.')).toBe(true);
    expect(fx.addGroup).not.toHaveBeenCalled();
    await type('First size (e.g. Small)', 'Regular');
    await type('Price', '1,200', 0);
    await tap('Add option group');
    expect(fx.addGroup).toHaveBeenCalledWith({ itemId: 'item-pizza', data: {
      name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: true, options: [{ name: 'Regular', additionalPrice: 1200 }],
    }, authSession: OWNER });
  });
});
