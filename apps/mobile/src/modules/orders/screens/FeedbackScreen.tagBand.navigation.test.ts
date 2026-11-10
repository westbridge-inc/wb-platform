/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [RATINGS · owner report 10 Nov 2026] "When the customer rates, it doesn't register."
//
// One way that was literally true: the tag chips follow the stars (1–3 stars: "What went wrong?",
// 4–5: "What was great?"), but a chip picked under one band STAYED picked, unseen, after the stars
// moved into the other band — and went to the server, which checks every tag against the stars'
// band and refused the whole rating ("Unknown tag for vendor: great-value"). The REAL FeedbackScreen
// is drawn by a real React renderer; the stars and chips are tappable stand-ins and the server is a
// recorder. Asserted: what is sent is exactly the chips on screen, for the store and for the rider.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => {
  const tok = (path: string): any => new Proxy(() => path, {
    get: (_t, k) => (k === Symbol.toPrimitive || k === 'toString' ? () => path : tok(`${path}.${String(k)}`)),
  });
  return {
    tok,
    sent: [] as Array<Record<string, unknown>>,
    order: { id: 'o1', vendor: { name: 'Westbridge Inc.', vendorType: 'STORE' }, rider: null as null | Record<string, unknown>, items: [] },
    tags: {
      VENDOR: {
        positive: [{ slug: 'great-value', label: 'Great value' }, { slug: 'tasty-food', label: 'Tasty food' }],
        negative: [{ slug: 'missing-items', label: 'Missing items' }, { slug: 'long-wait', label: 'Long wait' }],
      },
      RIDER: {
        positive: [{ slug: 'friendly', label: 'Friendly' }],
        negative: [{ slug: 'late', label: 'Late' }],
      },
    },
  };
});

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const View = (p: any) => h('div', { 'aria-label': p.accessibilityLabel }, p.children);
  const Pressable = (p: any) => h('div', { 'aria-label': p.accessibilityLabel, role: 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Pressable, Text: View, ScrollView: View, KeyboardAvoidingView: View, TextInput: () => h('input'),
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', async () => {
  const R = await import('react');
  return { Feather: (p: any) => R.createElement('i', { 'data-icon': p.name }) };
});
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn(), popToTop: vi.fn() }),
  useRoute: () => ({ params: { orderId: 'o1' } }),
}));
vi.mock('@swift/ui', () => ({ color: fx.tok('color'), font: fx.tok('font'), fontSize: fx.tok('fontSize'), radius: fx.tok('radius'), space: fx.tok('space') }));
vi.mock('../../../lib/images', () => ({ DARK_BLURHASH: '', vendorPhoto: () => null }));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    T: (p: any) => h('span', null, p.children), PopupTitle: Box, Screen: Box, Header: (p: any) => h('header', null, p.title),
    // A chip is a button named by its label, pressed or not.
    Chip: (p: any) => h('button', { type: 'button', 'aria-label': `chip ${p.label}`, 'aria-pressed': !!p.selected, onClick: p.onPress }, p.label),
    IconChip: () => null, LoadingBlock: () => h('div', null, 'Loading'),
    ErrorState: () => h('div', { role: 'alert' }),
    // Five tappable stars.
    Stars: (p: any) => h('div', null, [1, 2, 3, 4, 5].map((n) => h('button', { key: n, type: 'button', 'aria-label': `${n} stars`, onClick: () => p.onRate?.(n) }))),
    PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null),
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, onClick: p.disabled ? undefined : p.onPress }, p.label),
  };
});
vi.mock('../../../hooks/customer', () => ({
  useOrder: () => ({ data: fx.order, isLoading: false, isError: false, refetch: vi.fn() }),
  // The server stand-in: records the body exactly as the screen sends it.
  useRateOrder: () => ({ mutate: (body: Record<string, unknown>) => { fx.sent.push(body); }, isPending: false, isError: false, error: null }),
  useRatingTags: () => ({ data: fx.tags }),
  useItemFeedback: () => ({ mutateAsync: vi.fn() }),
}));

import { FeedbackScreen } from './FeedbackScreen';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function draw() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(FeedbackScreen)));
}
beforeEach(() => { fx.sent = []; fx.order.rider = null; });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const el = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const tap = async (label: string) => {
  const target = el(label);
  if (!target) throw new Error(`nothing on screen named "${label}"`);
  await act(async () => { target.click(); });
};
const pressed = () => [...host.querySelectorAll('[aria-pressed="true"]')].map((b) => b.getAttribute('aria-label'));

describe('[RATINGS] the rating sends exactly the chips on screen', () => {
  it('a chip picked at 5 stars is dropped when the stars move to 2 — the rating is not refused for it', async () => {
    await draw();
    await tap('5 stars');
    await tap('chip Great value');
    expect(pressed()).toEqual(['chip Great value']);
    await tap('2 stars'); // the chips are now "What went wrong?" — Great value is gone from the screen
    expect(el('chip Great value')).toBeNull();
    await tap('chip Missing items');
    await tap('Submit');
    expect(fx.sent).toEqual([{ vendorScore: 2, vendorTags: ['missing-items'] }]);
  });

  it('moving within one band keeps the chips; moving back does not resurrect a dropped one', async () => {
    await draw();
    await tap('5 stars');
    await tap('chip Great value');
    await tap('4 stars'); // still "What was great?"
    expect(pressed()).toEqual(['chip Great value']);
    await tap('3 stars');
    await tap('5 stars');
    expect(pressed()).toEqual([]);
    await tap('Submit');
    expect(fx.sent).toEqual([{ vendorScore: 5 }]);
  });

  it('a picked chip that leaves the screen for any other reason (the chip sets refreshed) is not sent either', async () => {
    const before = fx.tags.VENDOR.positive;
    try {
      await draw();
      await tap('5 stars');
      await tap('chip Great value');
      fx.tags.VENDOR.positive = before.filter((t) => t.slug !== 'great-value');
      await act(async () => root.render(h(FeedbackScreen))); // the sets came back without it
      expect(el('chip Great value')).toBeNull();
      await tap('Submit');
      expect(fx.sent).toEqual([{ vendorScore: 5 }]);
    } finally {
      fx.tags.VENDOR.positive = before;
    }
  });

  it('the rider step follows the same rule', async () => {
    fx.order.rider = { firstName: 'Ravi', lastName: 'S' };
    await draw();
    await tap('4 stars');
    await tap('Next');
    await tap('5 stars');
    await tap('chip Friendly');
    await tap('1 stars');
    await tap('Submit');
    expect(fx.sent).toEqual([{ vendorScore: 4, riderScore: 1 }]);
  });
});
