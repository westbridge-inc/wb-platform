/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [REVIEW #2516 S3-1] A price a store types is WHOLE Guyana dollars, 0 to 10,000,000 (the server's wholePrice(),
// vendor.routes.ts). The item editor took "1250.50" and the server answered "Invalid request data". Now the price box
// is a number pad, says "Prices are whole Guyana dollars.", reads "1,500" as 1500 and will not save cents or more than
// ten million. The REAL VendorItemEditorScreen in a real navigator, as VendorItemEditorScreen.discard.navigation.test.ts.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  save: vi.fn(),
  previewType: null as string | null,
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
  const input = (p: any) => h('input', { 'aria-label': p.placeholder, 'data-keyboard': p.keyboardType ?? 'default', value: p.value, onChange: (e: any) => p.onChangeText(e.target.value) });
  return {
    Card: Box, Screen: Box, IconChip: () => null, LinkText: () => null, PhotoDrop: () => null, Segmented: () => null,
    T: (p: any) => h('span', null, p.children), PopupTitle: Box,
    PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null),
    Chip: (p: any) => h('button', { type: 'button', 'aria-pressed': p.selected ? 'true' : 'false', onClick: p.onPress }, p.label),
    LabeledInput: input,
    PillButton: (p: any) => h('button', { type: 'button', disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.label),
    ConfirmDialog: (p: any) => (p.open
      ? h('div', { role: 'dialog' }, h('h2', null, p.title),
        h('button', { type: 'button', onClick: p.onClose }, p.cancelLabel ?? 'Cancel'),
        h('button', { type: 'button', onClick: p.onConfirm }, p.confirmLabel))
      : null),
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
vi.mock('../../../services/api', () => ({ vendorApi: {} }));
vi.mock('../../../hooks/storeVat', () => ({ useStoreVat: () => ({ data: undefined }) })); // [STORE-VAT] owner-only read, no VAT here
vi.mock('../../../hooks/useVendorMutation', () => ({ useVendorMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
// [MENU-OPTIONS] The option library and the option writes (sizes, halves, follow-ups): nothing shared here.
vi.mock('../../../hooks/menuOptions', () => ({
  useOptionLibrary: () => ({ data: [], isLoading: false }),
  useMenuOptionsWrite: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useVendorProfile: () => ({ store: { vendorType: 'RESTAURANT' } }),
    useSaveItem: () => ({ mutateAsync: fx.save, isPending: false }),
    useUploadItemImage: idle, useAddOptionGroup: idle, useDeleteOptionGroup: idle, useAddOption: idle, useDeleteOption: idle,
  };
});
vi.mock('../../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionSnapshot: () => ({ userId: 'owner', generation: 1 }),
  requireAuthSessionForPrincipal: (session: unknown) => session,
  // [OWNER-ASKS 9 Nov] the editor reads whether the owner has a profile photo (home visits): one on file, as before
  useAuthStore: (select: (state: unknown) => unknown) => select({ user: { selfieCapturedAt: '2026-11-01T00:00:00.000Z' } }),
}));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: 'store-A' }) } }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (select: (s: unknown) => unknown) => select({ previewType: fx.previewType }) }));
vi.mock('../../../lib/images', () => ({ mediaUrl: () => undefined, isKeptPhoto: () => false, storePhotoUrl: () => null, HERO_PHOTO_WIDTH: 1280 }));

import { VendorItemEditorScreen } from './VendorItemEditorScreen';

const nav = createNavigationContainerRef<Record<string, object | undefined>>();
const Stack = createNativeStackNavigator();
const h = React.createElement;
const VendorMenu = () => h('p', null, 'menu list');
const CATEGORIES = [{ id: 'mains', name: 'Mains' }];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  fx.previewType = null;
  fx.save.mockResolvedValue({ id: 'item-1' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const stack = () => nav.getRootState().routes.map((r) => r.name);
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
async function tap(label: string) {
  const el = button(label);
  expect(el, label).toBeTruthy();
  await act(async () => { el!.click(); });
  await settle();
}
async function type(placeholder: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(`input[aria-label="${placeholder}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); });
}
async function openNewItem() {
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Stack.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Stack.Screen, { key: 'VendorMenu', name: 'VendorMenu', component: VendorMenu }),
        h(Stack.Screen, { key: 'VendorItemEditor', name: 'VendorItemEditor', component: VendorItemEditorScreen }),
      ],
    }))));
  await act(async () => nav.navigate('VendorItemEditor', { categories: CATEGORIES }));
  await settle();
  expect(stack()).toEqual(['VendorMenu', 'VendorItemEditor']);
}

const priceBox = () => host.querySelector<HTMLInputElement>('input[aria-label="Price (GYD)"]')!;
const saveLabel = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent).find((t) => t === 'Add item' || t === 'Set a price');

describe('[REVIEW #2516 S3-1] the item editor takes whole Guyana dollars only', () => {
  it('the price box is a number pad and says prices are whole dollars', async () => {
    await openNewItem();
    expect(priceBox().getAttribute('data-keyboard')).toBe('number-pad');
    expect(host.textContent).toContain('Prices are whole Guyana dollars.');
  });

  it('cents, or more than 10,000,000, cannot be saved', async () => {
    await openNewItem();
    await type('Item name', 'Pepperpot');
    for (const typed of ['1250.50', '12.5', '10000001', 'abc', '-5']) {
      await type('Price (GYD)', typed);
      expect(saveLabel(), typed).toBe('Set a price');
    }
    await tap('Set a price');
    expect(fx.save).not.toHaveBeenCalled();
  });

  it('"1,500" is 1500; 0 and 10,000,000 are prices too (as the server takes them)', async () => {
    await openNewItem();
    await type('Item name', 'Pepperpot');
    await type('Price (GYD)', '1,500');
    expect(saveLabel()).toBe('Add item');
    await tap('Add item');
    expect(fx.save).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fx.save.mock.calls[0]![0])).toContain('"basePrice":1500');
  });

  it('0 and 10,000,000 can be saved', async () => {
    for (const typed of ['0', '10000000']) {
      await openNewItem();
      await type('Item name', 'Pepperpot');
      await type('Price (GYD)', typed);
      expect(saveLabel(), typed).toBe('Add item');
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });
});
