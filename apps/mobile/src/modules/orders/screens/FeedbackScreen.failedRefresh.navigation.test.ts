/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED 12 · 7 Nov 2026] FeedbackScreen used to show its error page whenever the order read was in error,
// even with the order on screen: a background refresh that failed (a weak signal) swapped the half-filled rating
// for "something went wrong". Only an order never read is an error now. The REAL FeedbackScreen, a real React
// renderer; the order read is a stand-in the cases switch.
// ---------------------------------------------------------------------------

interface Sent { body: { itemId: string; verdict: 'UP' | 'DOWN' }; ok: () => void; fail: () => void }

const fx = vi.hoisted(() => {
  /** A design token that prints its own path (`color.brand.600`), so the thumb's colour can be read. */
  const tok = (path: string): any => new Proxy(() => path, {
    get: (_t, k) => (k === Symbol.toPrimitive || k === 'toString' ? () => path : tok(`${path}.${String(k)}`)),
  });
  return {
    tok,
    sent: [] as Sent[],
    read: null as unknown as { data: unknown; isLoading: boolean; isError: boolean; refetch: () => void },
    order: {
      id: 'o1', vendor: { name: 'Corner Store' }, rider: null,
      items: [{ id: 'l1', itemId: 'i1', name: 'Rice' }, { id: 'l2', itemId: 'i2', name: 'Juice' }],
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
  return { Feather: (p: any) => R.createElement('i', { 'data-icon': p.name, 'data-color': String(p.color) }) };
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
    Chip: (p: any) => h('span', null, p.label), IconChip: () => null, LoadingBlock: () => h('div', null, 'Loading'),
    ErrorState: () => h('div', { role: 'alert' }), Stars: () => null, PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
  };
});
// The order and the star rating are stand-ins; the item verdict is a REAL mutation over a stand-in server.
vi.mock('../../../hooks/customer', async () => {
  const { useMutation } = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    useOrder: () => fx.read,
    useRateOrder: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
    useRatingTags: () => ({ data: {} }),
    useItemFeedback: () => useMutation({
      mutationFn: (body: Sent['body']) => new Promise<void>((resolve, reject) => {
        fx.sent.push({ body, ok: () => resolve(), fail: () => reject(new Error('down')) });
      }),
      meta: { silent: true },
    }),
  };
});

import { FeedbackScreen } from './FeedbackScreen';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let qc: QueryClient;
const draw = async () => { await act(async () => root.render(h(QueryClientProvider, { client: qc }, h(FeedbackScreen)))); };

beforeEach(async () => {
  fx.sent = [];
  fx.read = { data: fx.order, isLoading: false, isError: false, refetch: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await draw();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const thumb = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const lit = (label: string) => thumb(label)?.querySelector('i')?.getAttribute('data-color') === 'color.brand.600';
const errorShown = () => !!host.querySelector('[role="alert"]');

describe('[APP-SPEED 12] a failed background refresh never wipes a half-filled rating', () => {
  it('the order on screen fails to refresh: the form stays, with what the customer already chose', async () => {
    await act(async () => { thumb('Liked Rice')!.click(); });
    expect(lit('Liked Rice')).toBe(true);
    fx.read = { ...fx.read, isError: true }; // a background refetch failed; the order read before is still held
    await draw();
    expect(errorShown(), 'no error page over a form the customer is filling').toBe(false);
    expect(thumb('Liked Rice')).not.toBeNull();
    expect(lit('Liked Rice')).toBe(true);
  });

  it('an order the screen never read (the first read failed): the error with its retry, as before', async () => {
    fx.read = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    await draw();
    expect(errorShown()).toBe(true);
    expect(thumb('Liked Rice')).toBeNull();
  });
});
