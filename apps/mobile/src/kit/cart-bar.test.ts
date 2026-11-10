import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [E09] The pinned "View cart" bar is ONE kit component and every browse
// surface renders it. This file pins the component's own behaviour, rendered
// with react-native stubbed (see card.test.ts): it reads the cart through the
// shared `useCart` hook, shows only while the basket has items, names itself
// to a screen reader, floats above the home indicator, and jumps straight to
// the Cart tab. Screen wiring is pinned by the sibling source test.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  cart: { data: undefined as any },
  cartArgs: [] as unknown[],
  auth: { isAuthenticated: true },
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

vi.mock('@swift/ui', () => ({
  color: { brand: { 500: '#brand-500' } },
  elevation: { floating: { boxShadow: '0px 12px 24px rgba(33,26,26,0.22)', elevation: 10 } },
  space: { xs: 4, lg: 16, xl: 20, '2xl': 24 },
}));

vi.mock('../hooks/customer', () => ({
  useCart: (...args: unknown[]) => {
    mocks.cartArgs = args;
    return mocks.cart;
  },
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: (select: (s: typeof mocks.auth) => unknown) => select(mocks.auth),
}));

vi.mock('./money', () => ({ Money: 'Money' }));
vi.mock('./text', () => ({ T: 'T' }));

import { CART_BAR_HEIGHT, CartBar, useCartBarClearance } from './cart-bar';

type El = ReactElement<Record<string, any>, string>;

/** Render while items are present — the empty case is asserted separately. */
function bar(vendorId?: string): El {
  const out = CartBar({ vendorId }) as El | null;
  expect(out, 'CartBar must render while the cart has items').not.toBeNull();
  return out!;
}

/** Through the Pressable render-prop into the visible pill. */
function pill(el: El): El {
  expect(el.type).toBe('Pressable');
  const view = el.props['children']({ pressed: false }) as El;
  expect(view.type).toBe('View');
  return view;
}

function flatten(node: any, out: any[] = []): any[] {
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return out;
  }
  out.push(node);
  flatten(node.props?.children, out);
  return out;
}

function textOf(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

describe('CartBar — the one pinned door to the Cart tab', () => {
  it('goes back to the Cart tab ({ pop: true }: never a second tab bar, UI-SWEEP U09)', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 2 }], subtotalCustomer: 1500, vendorId: 'vendor-1' };
    mocks.navigate.mockClear();

    bar().props['onPress']();

    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('Tabs', { screen: 'Cart' }, { pop: true });
  });

  it('shows the live count and subtotal from the cart query', () => {
    mocks.cart.data = {
      items: [{ itemId: 'i1', quantity: 2 }, { itemId: 'i2', quantity: 1 }],
      subtotalCustomer: 1500,
      vendorId: 'vendor-1',
    };

    const els = flatten(pill(bar()));
    const texts = els.filter((node) => node.type === 'T').map(textOf);
    const moneyEl = els.find((node) => node.type === 'Money');

    expect(texts).toContain('View cart');
    expect(texts).toContain('3 items ·');
    expect(moneyEl.props.amount).toBe(1500);
  });

  it('is reachable to a screen reader with the count in the label', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };

    const el = bar();

    expect(el.props['accessibilityRole']).toBe('button');
    expect(el.props['accessibilityLabel']).toBe('View cart, 1 item');
  });

  it('is hidden while the cart is empty', () => {
    mocks.cart.data = { items: [], subtotalCustomer: 0, vendorId: 'vendor-1' };
    expect(CartBar({})).toBeNull();
  });

  it('is hidden while every line is at zero', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 0 }], subtotalCustomer: 0, vendorId: 'vendor-1' };
    expect(CartBar({})).toBeNull();
  });

  it("a storefront never shows another store's basket", () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };

    expect(CartBar({ vendorId: 'vendor-2' })).toBeNull();
    expect(bar('vendor-1').type).toBe('Pressable');
  });

  it("floats above the home indicator instead of covering the screen's bottom content", () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };

    // The PRESSABLE floats (see the Android block below): the pill it draws
    // fills that box exactly, so the visible bar and the touch box are one.
    expect(bar().props['style']).toMatchObject({
      position: 'absolute',
      left: 24,
      right: 24,
      bottom: 34 + 16,
      height: 52,
    });
  });
});

describe('[ANDROID 9 Nov] the pill IS the press target, so a real finger opens the cart', () => {
  // A shopper on Android (Search -> Groceries, "No matches") tapped
  // "View cart · 1 item" and nothing happened.
  //
  // React Native's Pressability (RN 0.85 Libraries/Pressability/Pressability.js)
  // measures the Pressable's OWN host view when the touch starts, and drops the
  // press on any move outside that box plus its retention offsets
  // (DEFAULT_PRESS_RECT_OFFSETS: top/left/right 20, bottom 30). Android reports
  // move events during nearly every real tap (the finger wobbles a pixel).
  //
  // The bar used to be an in-flow Pressable whose ONLY child, the pill, was
  // absolutely positioned. A box whose children are all absolute has no height
  // of its own, so the Pressable was a 0pt-tall strip at the screen's bottom
  // edge and the pill floated (inset + 16 + 52)pt above it: every wobble
  // landed outside the measured box and the release never became a press.
  const SCREEN = { width: 390, height: 844 };
  const RETENTION = { top: 20, left: 20, right: 20, bottom: 30 };
  type Box = { left: number; top: number; right: number; bottom: number };
  type Style = Record<string, any> | undefined;

  const styleOf = (el: El | string | number | null | undefined): Style => {
    if (el == null || typeof el !== 'object' || !el.props) return undefined; // text runs have no box
    const s = el.props['style'];
    return (Array.isArray(s) ? Object.assign({}, ...s) : s) as Style;
  };
  const isAbsolute = (s: Style) => s?.['position'] === 'absolute';

  /** Where Yoga puts an absolutely positioned box inside its parent's box. */
  function placeAbsolute(s: Record<string, any>, parent: Box): Box {
    const left = parent.left + (s['left'] ?? 0);
    const right = parent.right - (s['right'] ?? 0);
    const bottom = parent.bottom - (s['bottom'] ?? 0);
    return { left, right, bottom, top: bottom - s['height'] };
  }

  /**
   * The bar's two boxes on a 390x844 screen, where every surface mounts it as
   * the LAST child of its Screen, below a flex:1 list.
   * - pressBox: the Pressable's own host view (what Pressability measures).
   * - pillBox: the visible pill the shopper aims at.
   */
  function layout(el: El): { pressBox: Box; pillBox: Box } {
    const screen: Box = { left: 0, top: 0, right: SCREEN.width, bottom: SCREEN.height };
    const pillEl = el.props['children']({ pressed: false }) as El;
    const own = styleOf(el);
    const pillStyle = styleOf(pillEl);

    let pressBox: Box;
    if (isAbsolute(own)) {
      pressBox = placeAbsolute(own!, screen);
    } else {
      // In flow under a flex:1 list: it sits at the screen's bottom edge, as tall
      // as its in-flow content — and an absolute child adds no height.
      const contentHeight = isAbsolute(pillStyle) ? 0 : Number(pillStyle?.['height'] ?? 0);
      pressBox = { left: 0, right: SCREEN.width, bottom: SCREEN.height, top: SCREEN.height - contentHeight };
    }
    const pillBox = isAbsolute(pillStyle) ? placeAbsolute(pillStyle!, pressBox) : pressBox;
    return { pressBox, pillBox };
  }

  /** Pressability's own test: is this touch still inside the measured box + retention? */
  const stillPressing = (box: Box, x: number, y: number) =>
    x > box.left - RETENTION.left && x < box.right + RETENTION.right && y > box.top - RETENTION.top && y < box.bottom + RETENTION.bottom;

  it('a tap anywhere on the pill that wobbles a few points is still a press', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 2000, vendorId: 'vendor-1' };
    const { pressBox, pillBox } = layout(bar());

    // The pill is where the shopper sees it: above the home indicator.
    expect(pillBox).toEqual({ left: 24, right: 390 - 24, bottom: 844 - (34 + 16), top: 844 - (34 + 16) - 52 });

    const cx = (pillBox.left + pillBox.right) / 2;
    const cy = (pillBox.top + pillBox.bottom) / 2;
    const aims: Array<[string, number, number]> = [
      ['the middle', cx, cy],
      ['"View cart" (left end)', pillBox.left + 30, cy],
      ['the total (right end)', pillBox.right - 30, cy],
      ['the top edge', cx, pillBox.top + 4],
      ['the bottom edge', cx, pillBox.bottom - 4],
    ];
    for (const [where, x, y] of aims) {
      for (const [dx, dy] of [[0, 0], [2, 1], [-1, 3], [0, -3]] as const) {
        expect(stillPressing(pressBox, x + dx, y + dy), `a tap on ${where} moved (${dx},${dy}) must stay a press`).toBe(true);
      }
    }
  });

  it('the Pressable is the floating box and the pill only fills it: nothing is drawn outside the touch box', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 2000, vendorId: 'vendor-1' };
    const el = bar();
    const { pressBox, pillBox } = layout(el);

    expect(isAbsolute(styleOf(el)), 'the Pressable itself is absolutely positioned').toBe(true);
    expect(pressBox).toEqual(pillBox);
    for (const node of flatten(el.props['children']({ pressed: false }))) {
      expect(isAbsolute(styleOf(node)), `${String(node.type)} inside the bar must not be absolutely positioned`).toBe(false);
    }
  });

  it('the same press opens the Cart tab (the press reaches the one handler)', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 2000, vendorId: 'vendor-1' };
    mocks.navigate.mockClear();
    const el = bar();
    const { pressBox, pillBox } = layout(el);
    const cy = (pillBox.top + pillBox.bottom) / 2;

    if (stillPressing(pressBox, 195 + 2, cy + 1)) el.props['onPress']();

    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('Tabs', { screen: 'Cart' }, { pop: true });
  });
});

describe('[E09] a list leaves room for the bar while it floats over it', () => {
  it("the clearance is the bar's whole footprint above the screen edge while it shows", () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };
    // bottom inset 34 + space.lg 16 + the 52pt pill
    expect(CART_BAR_HEIGHT).toBe(52);
    expect(useCartBarClearance()).toBe(34 + 16 + 52);
  });

  it('is zero while the bar is hidden, so an empty basket changes no layout', () => {
    mocks.cart.data = { items: [], subtotalCustomer: 0, vendorId: 'vendor-1' };
    expect(useCartBarClearance()).toBe(0);
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 0 }], subtotalCustomer: 0, vendorId: 'vendor-1' };
    expect(useCartBarClearance()).toBe(0);
  });

  it("follows the storefront gate: no room reserved for another store's basket", () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };
    expect(useCartBarClearance({ vendorId: 'vendor-2' })).toBe(0);
    expect(useCartBarClearance({ vendorId: 'vendor-1' })).toBe(34 + 16 + 52);
  });
});

describe('[E09] a signed-out shopper has no basket to reach', () => {
  it('never reads the cart while signed out: the shared query is disabled, not fired into a 401', () => {
    mocks.auth.isAuthenticated = false;
    mocks.cart.data = undefined;
    try {
      expect(CartBar({})).toBeNull();
      // useCart(lat, lng, choices, enabled): the same key as every cart surface, enabled only when signed in
      expect(mocks.cartArgs).toEqual([undefined, undefined, undefined, false]);
      expect(useCartBarClearance()).toBe(0);
    } finally {
      mocks.auth.isAuthenticated = true;
    }
  });

  it('shows nothing and reserves no room signed out, even if a basket were still cached', () => {
    mocks.auth.isAuthenticated = false;
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 2 }], subtotalCustomer: 900, vendorId: 'vendor-1' };
    try {
      expect(CartBar({})).toBeNull();
      expect(useCartBarClearance()).toBe(0);
    } finally {
      mocks.auth.isAuthenticated = true;
    }
  });

  it('reads the shared query, enabled, once signed in', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };
    expect(CartBar({})).not.toBeNull();
    expect(mocks.cartArgs).toEqual([undefined, undefined, undefined, true]);
  });
});

describe('the bar reads the cart through the shared hook', () => {
  it('reads the cart through useCart (the storefront no-quote key), never a direct API call', () => {
    const src = readFileSync(new URL('./cart-bar.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/useCart</);
    expect(src).not.toMatch(/getCart/);
  });
});

describe('[ANDROID-QA A8] the storefront bar reads the cart the API actually returns', () => {
  // GET /customer/cart has no top-level vendorId: each line carries its store,
  // plus `vendor` (the first store) and `vendors[]` (one plan per store; the
  // basket can hold more than one store). Captured from the real API on 5 Oct.
  const realCart = (lines: Array<{ vendorId: string; quantity: number }>) => ({
    id: 'cart-1',
    vendor: { id: lines[0]?.vendorId, name: 'Store' },
    items: lines.map((l, i) => ({ id: `ci${i}`, itemId: `i${i}`, vendorId: l.vendorId, quantity: l.quantity })),
    vendors: [...new Set(lines.map((l) => l.vendorId))].map((vendorId) => ({ vendorId })),
    subtotalCustomer: 700,
  });

  it("shows on the storefront whose items are in the basket", () => {
    mocks.cart.data = realCart([{ vendorId: 'vendor-1', quantity: 2 }]);
    expect(CartBar({ vendorId: 'vendor-1' })).not.toBeNull();
    expect(useCartBarClearance({ vendorId: 'vendor-1' })).toBe(34 + 16 + 52);
  });

  it("stays hidden on a storefront with nothing in the basket", () => {
    mocks.cart.data = realCart([{ vendorId: 'vendor-1', quantity: 2 }]);
    expect(CartBar({ vendorId: 'vendor-2' })).toBeNull();
    expect(useCartBarClearance({ vendorId: 'vendor-2' })).toBe(0);
  });

  it('shows on every store of a two-store basket', () => {
    mocks.cart.data = realCart([{ vendorId: 'vendor-1', quantity: 1 }, { vendorId: 'vendor-2', quantity: 1 }]);
    expect(CartBar({ vendorId: 'vendor-1' })).not.toBeNull();
    expect(CartBar({ vendorId: 'vendor-2' })).not.toBeNull();
    expect(CartBar({ vendorId: 'vendor-3' })).toBeNull();
  });
});
