/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED A · owner 7 Nov] The Cart tab's first open asked a quote the phone
// had never asked (its own place and choices) and drew a spinner, although the
// store page had just read the same server cart. That quote now stands in,
// flagged as placeholder data: the lines show at once, the total says
// "Updating…", and Place order is HELD until this tab's own quote lands. The
// REAL cart screen (the harness of CartLostReply); the quote hook hands over
// each state. The hook's own stand-in is proven in
// hooks/customer.doorPlaceholders.navigation.test.ts.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => {
  class CheckoutAlreadyPlacedError extends Error {
    constructor(readonly orderIds: string[]) { super('This order was already placed.'); }
  }
  class CheckoutInFlightError extends Error {}
  class CheckoutOutcomeUnknownError extends Error {}
  return {
    CheckoutAlreadyPlacedError, CheckoutInFlightError, CheckoutOutcomeUnknownError,
    navigate: vi.fn(),
    place: vi.fn(),
    reset: vi.fn(),
    cart: null as any,
    standIn: false,
    focused: true,
    signedIn: true,
    availability: vi.fn(() => new Promise(() => {})),
    fetching: false,
    cartArgs: [] as unknown[][],
    error: null as unknown,
    checkingOutcome: false,
    recovery: { recovering: false, placedOrderIds: null as string[] | null },
  };
});
const CART = {
  id: 'cart', vendor: { id: 'store', name: 'Test store' },
  items: [{ id: 'line', itemId: 'item', vendorId: 'store', name: 'Test item', quantity: 1, fulfillment: 'DELIVERY', isAvailable: true, lineTotal: 2000, customerPrice: 2000 }],
  deliveryAddress: { addressLine1: 'Test address', city: 'Georgetown' },
  itemCount: 1, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, tipAmount: 0, meetsMinimum: true,
};

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View: Box, ScrollView: Box, Pressable: (p: any) => h('button', { onClick: p.onPress, 'aria-label': p.accessibilityLabel }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children),
    Platform: { OS: 'android' }, Alert: { alert: vi.fn() }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ canGoBack: () => false, navigate: fx.navigate }), useFocusEffect: () => undefined, useIsFocused: () => fx.focused }));
vi.mock('../../../services/api', () => ({ customerApi: { validatePromo: vi.fn(), getDeliveryAvailability: fx.availability } }));
vi.mock('../../../services/notification-priming', () => ({ maybePrimeNotifications: vi.fn() }));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: () => ({ isAuthenticated: fx.signedIn, promptLogin: vi.fn() }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: 6.8, longitude: -58.16 }) }));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => undefined }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn() } }));
vi.mock('../../../lib/payLink', () => ({ openMmgPaymentAction: vi.fn() }));
vi.mock('../../../kit/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), show: vi.fn() } }));
vi.mock('../../../hooks/customer', () => {
  const mutation = () => ({ isPending: false, mutate: vi.fn(), reset: vi.fn() });
  return {
    // [APP-SPEED A] The Cart tab's FIRST quote: another quote of the same cart stands in, flagged.
    useCart: (...args: unknown[]) => {
      fx.cartArgs.push(args);
      return { data: fx.cart, isLoading: false, isFetching: fx.fetching, isPlaceholderData: fx.standIn, refetch: vi.fn() };
    },
    useClearCart: mutation, useRemoveCartItem: mutation, useRemoveCartPromo: mutation, useSetCartTip: mutation, useUpdateCartItem: mutation, useAddToCart: mutation, // [TAP-AUDIT] the steppers' add
    usePlaceOrder: () => ({
      ...mutation(), mutate: fx.place, reset: fx.reset,
      error: fx.error, isError: fx.error != null, isSuccess: false, checkingOutcome: fx.checkingOutcome,
    }),
    useCheckoutRecovery: () => fx.recovery,
    CheckoutAlreadyPlacedError: fx.CheckoutAlreadyPlacedError, CheckoutInFlightError: fx.CheckoutInFlightError,
    CheckoutOutcomeUnknownError: fx.CheckoutOutcomeUnknownError, CHECKING_ORDER_MESSAGE: "We're checking whether your order went through.",
  };
});
vi.mock('../../../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  const Button = (p: any) => h('button', { disabled: p.disabled || p.loading, onClick: p.onPress }, p.label);
  return {
    Screen: Box, T: Box, PopupTitle: Box,
    PillButton: Button, Chip: Button,
    PopupCard: (p: any) => p.visible ? h('div', null, p.children) : null,
    LabeledInput: (p: any) => h('div', null, h('input', { placeholder: p.placeholder, value: p.value, readOnly: true }), p.right),
    InfoRow: (p: any) => h('div', null, p.label, p.value),
    Money: (p: any) => h('span', null, p.amount),
    AddMorph: () => null, Photo: () => null, IconChip: () => null, LockInDisc: () => null,
    EmptyState: (p: any) => h('section', { 'data-empty': p.title }, h('h2', null, p.title), p.body ? h('p', null, p.body) : null,
      p.actionLabel ? h('button', { onClick: p.onAction }, p.actionLabel) : null),
    ErrorState: () => h('div', null, 'Error'), LoadingBlock: () => h('div', null, 'Loading'),
  };
});
vi.mock('../../../kit/controls', async () => ({ BrandSwitch: (p: any) => React.createElement('button', { onClick: p.onChange }, p.label) }));

import { CartScreen } from './CartScreen';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  fx.cart = CART; fx.error = null; fx.checkingOutcome = false; fx.standIn = false; fx.fetching = false; fx.cartArgs = []; fx.focused = true; fx.signedIn = true;
  fx.recovery = { recovering: false, placedOrderIds: null };
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined;
});

async function render() {
  await act(async () => root!.render(React.createElement(QueryClientProvider, { client }, React.createElement(CartScreen))));
}
const text = () => host.textContent ?? '';
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe('[APP-SPEED A] the Cart tab opens on the cart the phone already has', () => {
  it('lines at once, total "Updating…", Place order held; this tab’s own quote frees it', async () => {
    fx.standIn = true; fx.fetching = true;
    await render();

    // the Cart tab asks for the stand-in (enabled, from any cached quote of the same cart)
    expect(fx.cartArgs.filter((args) => args.length === 5).at(-1)!.slice(3)).toEqual([true, true]);
    // (a) at once
    expect(text()).toContain('Test item');
    expect(text()).toContain('Updating…');
    // (b) money waits for this tab's own quote
    expect(button('Place order'), 'Place order is on screen').toBeDefined();
    expect(button('Place order')!.disabled).toBe(true);
    await act(async () => button('Place order')!.click());
    expect(fx.place).not.toHaveBeenCalled();

    // (c) this tab's own quote lands
    fx.standIn = false; fx.fetching = false;
    await render();
    expect(text()).not.toContain('Updating…');
    expect(button('Place order')!.disabled).toBe(false);
  });

  it('offline (the quote read paused, nothing in flight): the stand-in alone still holds Place order', async () => {
    fx.standIn = true; fx.fetching = false;
    await render();
    expect(text()).toContain('Updating…');
    expect(button('Place order')!.disabled).toBe(true);
  });
});

describe('[APP-SPEED A · review S2-1] the Cart tab drawn ahead reads nothing until it is first shown', () => {
  /** The Cart tab's own quote call (the pickup-retry quote is the other useCart call). */
  const tabQuote = () => fx.cartArgs.filter((args) => args.length === 5).at(-1)!;
  const lastEnabled = () => tabQuote()[3];

  it('hidden and never opened: the quote and the rider read are held; the first focus opens them, for good', async () => {
    fx.focused = false;
    await render();
    expect(lastEnabled(), 'the quote is held while the tab was never shown').toBe(false);
    expect(tabQuote()[4], 'a remembered quote of the same cart may still be drawn').toBe(true);
    expect(fx.availability).not.toHaveBeenCalled();

    fx.focused = true;
    await render();
    expect(lastEnabled()).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(fx.availability, 'the rider read goes once the cart is shown').toHaveBeenCalled();

    // Latched: leaving the tab keeps it live, exactly as before this change.
    fx.focused = false;
    await render();
    expect(lastEnabled()).toBe(true);
  });

  it('a guest’s Cart (shown or not) asks for no quote', async () => {
    fx.signedIn = false;
    await render();
    expect(lastEnabled()).toBe(false);
    expect(fx.availability).not.toHaveBeenCalled();
  });
});

