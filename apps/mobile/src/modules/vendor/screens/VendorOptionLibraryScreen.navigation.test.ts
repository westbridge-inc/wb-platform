/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] The store's option library: a group built once and attached to many items;
// editing it changes every item that uses it. The REAL VendorOptionLibraryScreen in a real NavigationContainer +
// native-stack; the kit, the library read and the network are stand-ins (each write is checked as sent).
// ---------------------------------------------------------------------------

const ok = (data: unknown) => Promise.resolve({ data: { data } });
const fx = vi.hoisted(() => ({
  library: [] as any[],
  menu: [] as any[],
  write: vi.fn(),
  toast: vi.fn(),
  api: {} as Record<string, any>,
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


vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }) }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  const press = (p: any) => h('button', { type: 'button', disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.label);
  return {
    Card: Box, Screen: Box, PopupTitle: Box,
    Header: (p: any) => h('header', null, h('button', { type: 'button', onClick: p.onBack }, 'Back'), h('h1', null, p.title)),
    T: (p: any) => h('span', null, p.children),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    Chip: (p: any) => h('button', { type: 'button', 'aria-pressed': p.selected ? 'true' : 'false', onClick: p.onPress }, p.label),
    LinkText: press, PillButton: press,
    ConfirmDialog: (p: any) => (p.open
      ? h('div', { role: 'alertdialog' }, h('h2', null, p.title), h('p', null, p.body),
        h('button', { type: 'button', onClick: p.onClose }, p.cancelLabel ?? 'Cancel'),
        h('button', { type: 'button', onClick: p.onConfirm }, p.confirmLabel))
      : null),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: fx.toast, success: vi.fn(), error: vi.fn() } }));
vi.mock('../shared', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    GUTTER: 16,
    InlineInput: (p: any) => h('input', { 'aria-label': p.placeholder, value: p.value, onChange: (e: any) => p.onChangeText(e.target.value) }),
  };
});
vi.mock('../../../services/api', () => ({ vendorApi: fx.api }));
vi.mock('../../../hooks/vendorops', () => ({
  useVendorProfile: () => ({ store: { vendorType: 'RESTAURANT' } }),
  useVendorMenu: () => ({ data: fx.menu, isLoading: false }),
}));
vi.mock('../../../hooks/menuOptions', () => ({
  useOptionLibrary: () => ({ data: fx.library, isLoading: false, isFetching: false }),
  useMenuOptionsWrite: () => ({ mutateAsync: fx.write, isPending: false }),
}));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (select: (s: unknown) => unknown) => select({ previewType: null }) }));

import { VendorOptionLibraryScreen } from './VendorOptionLibraryScreen';

const nav = createNavigationContainerRef<Record<string, object | undefined>>();
const Stack = createNativeStackNavigator();
const h = React.createElement;
const VendorMenu = () => h('p', null, 'menu list');

const TOPPINGS = {
  id: 'lib-top', name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 10, sortOrder: 1, setsPrice: false, allowHalves: true,
  halfPricePercent: 50, isFollowUp: false, usedByItemCount: 2, usedByItems: [{ id: 'i-marg', name: 'Margherita' }, { id: 'i-veg', name: 'Veggie' }],
  options: [{ id: 'lo-pep', name: 'Pepperoni', price: 400, isDefault: false, isAvailable: true, sortOrder: 0, followUpGroupId: null, externalCode: 'PEP' }],
};
const SIZE = {
  id: 'lib-size', name: 'Pizza size', isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 0, setsPrice: true, allowHalves: false,
  halfPricePercent: 100, isFollowUp: false, usedByItemCount: 4, usedByItems: [], options: [{ id: 'lo-l', name: 'Large', price: 3200, isDefault: false, isAvailable: true, sortOrder: 0, followUpGroupId: null, externalCode: null }],
};
const DIPS = {
  id: 'lib-dips', name: 'Dips', isRequired: false, minSelect: 0, maxSelect: 1, sortOrder: 2, setsPrice: false, allowHalves: false,
  halfPricePercent: 100, isFollowUp: false, usedByItemCount: 0, usedByItems: [], options: [],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  fx.library = [SIZE, TOPPINGS, DIPS];
  fx.menu = [{ id: 'mains', items: [{ id: 'i-marg', name: 'Margherita' }, { id: 'i-veg', name: 'Veggie' }, { id: 'i-hawaii', name: 'Hawaiian' }] }];
  for (const k of ['orderModifierGroups', 'createModifierGroup', 'updateModifierGroup', 'deleteModifierGroup', 'addModifierOption',
    'updateModifierOption', 'deleteModifierOption', 'attachModifierGroup', 'detachModifierGroup']) fx.api[k] = vi.fn(() => ok({}));
  fx.api['createModifierGroup'] = vi.fn(() => ok({ id: 'lib-new' }));
  fx.api['deleteModifierGroup'] = vi.fn(() => ok({ deleted: true, removedFromItems: 2 }));
  fx.write.mockImplementation(async (send: () => Promise<any>) => (await send())?.data?.data);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const buttons = (label: string) => Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === label || b.getAttribute('aria-label') === label);
const text = () => host.textContent ?? '';
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
async function open(params?: Record<string, unknown>) {
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Stack.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Stack.Screen, { key: 'VendorMenu', name: 'VendorMenu', component: VendorMenu }),
        h(Stack.Screen, { key: 'VendorOptionLibrary', name: 'VendorOptionLibrary', component: VendorOptionLibraryScreen }),
      ],
    }))));
  await act(async () => nav.navigate('VendorOptionLibrary', params));
  await settle();
}

describe('[MENU-OPTIONS] the option library', () => {
  it('lists each shared group with how many items use it, and reorders it', async () => {
    await open();
    expect(text()).toContain('Used by 4 items');
    expect(text()).toContain('Used by 2 items');
    expect(text()).toContain('Used by 0 items');
    await tap('Move Toppings up');
    expect(fx.api['orderModifierGroups']).toHaveBeenCalledWith(['lib-top', 'lib-size', 'lib-dips']);
  });

  it('a new shared group is created with its rules, then opens for its choices', async () => {
    await open();
    await tap('New shared group');
    await type('Group name (e.g. Pizza size, Toppings)', 'Crust');
    await tap('Required');
    await tap('Create group');
    expect(fx.api['createModifierGroup']).toHaveBeenCalledWith({ name: 'Crust', isRequired: true, minSelect: 1, maxSelect: 1 });
  });

  it('editing a shared group warns it changes every item, and saves every flag', async () => {
    await open({ groupId: 'lib-top' });
    expect(text()).toContain('Changes apply to all 2 items');
    await tap('Full price');
    await tap('Save group');
    expect(fx.api['updateModifierGroup']).toHaveBeenCalledWith('lib-top', {
      name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 10, setsPrice: false, allowHalves: true, halfPricePercent: 100,
    });
  });

  it('a choice: its price, sold out, kitchen code and the follow-up group it opens', async () => {
    await open({ groupId: 'lib-top' });
    expect(text()).toContain('+$400 · Kitchen code PEP');
    await tap('Available');
    expect(fx.api['updateModifierOption']).toHaveBeenCalledWith('lo-pep', { isAvailable: false });
    await tap('Opens follow-up group');
    const offered = Array.from(host.querySelectorAll('[role="dialog"] button')).map((b) => b.textContent);
    expect(offered, 'never itself, never a group that sets the price').toEqual(['Dips', 'Opens nothing', 'Cancel']);
    await tap('Dips');
    expect(fx.api['updateModifierOption']).toHaveBeenCalledWith('lo-pep', { followUpGroupId: 'lib-dips' });
    await type('Choice (e.g. Large)', 'Mushroom');
    await type('+GYD', '300');
    await type('Kitchen code (optional)', 'MSH');
    await tap('Add choice');
    expect(fx.api['addModifierOption']).toHaveBeenCalledWith('lib-top', { name: 'Mushroom', price: 300, externalCode: 'MSH' });
  });

  it('a size group\'s choices are the price ("Price"), not an extra', async () => {
    await open({ groupId: 'lib-size' });
    expect(text()).toContain('Price $3,200');
  });

  it('bulk attach / detach sends only the change', async () => {
    await open({ groupId: 'lib-top' });
    await tap('Choose items');
    await tap('Veggie');
    await tap('Hawaiian');
    await tap('Save items');
    expect(fx.api['attachModifierGroup']).toHaveBeenCalledWith('lib-top', ['i-hawaii']);
    expect(fx.api['detachModifierGroup']).toHaveBeenCalledWith('lib-top', ['i-veg']);
  });

  it('delete says how many items lose it, and tells how many it was removed from', async () => {
    await open({ groupId: 'lib-top' });
    await tap('Delete group');
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('It is removed from 2 items that use it.');
    await tap('Delete group', 1);
    expect(fx.api['deleteModifierGroup']).toHaveBeenCalledWith('lib-top');
    expect(fx.toast).toHaveBeenCalledWith('Deleted. Removed from 2 items.');
  });

  it('the server\'s refusal is shown in its own words', async () => {
    fx.write.mockRejectedValueOnce({ response: { data: { error: { code: 'MENU_OPTIONS_RULE', message: '"Pepperoni" cannot open its own group.' } } } });
    await open({ groupId: 'lib-top' });
    await tap('Available');
    expect(text()).toContain('"Pepperoni" cannot open its own group.');
  });
});
