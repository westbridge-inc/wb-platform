/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-SPEED C · report item 12] A driver's trip history grows twenty rows at a time ("Load more"). It used to be a
// ScrollView that kept every loaded trip mounted (a busy driver's hundreds of cards); it is a FlatList now, so only
// the rows near the screen are drawn. The REAL screen; the history read and native drawing are stand-ins (the
// FlatList draws its header, rows and footer inside a marked box and records the keys it was given). The states
// (loading, failure, confirmed empty) and the pull to refresh are unchanged.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  q: {} as Record<string, unknown>,
  keys: [] as string[],
  refresh: null as null | (() => void),
  invalidate: vi.fn(async () => {}),
}));

vi.mock('react-native', async () => {
  const { createElement: h, Fragment } = await import('react');
  const el = (c: any) => (c == null ? null : React.isValidElement(c) ? c : h(c));
  return {
    View: (p: any) => h('div', null, p.children),
    ScrollView: (p: any) => h('div', { 'data-rn': 'scroll' }, p.children),
    RefreshControl: (p: any) => { fx.refresh = p.onRefresh; return null; },
    FlatList: (p: any) => {
      const data: any[] = p.data ?? [];
      fx.keys = data.map((item, index) => p.keyExtractor(item, index));
      return h('div', { 'data-rn': 'flatlist' }, el(p.refreshControl), el(p.ListHeaderComponent),
        data.map((item, index) => h(Fragment, { key: fx.keys[index] }, p.renderItem({ item, index }))),
        el(p.ListFooterComponent));
    },
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => {
  const token: any = new Proxy({}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, fontSize: token, radius: token, space: token };
});
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: fx.invalidate }) }));
vi.mock('../../../hooks', () => ({
  useMoverKind: () => ({ kind: 'DRIVER', loading: false, error: null, refetch: vi.fn() }),
  useJobHistory: () => fx.q,
}));
vi.mock('../shared', () => ({ JobStatusPill: () => null, RoutePair: () => null, whenLabel: () => '' }));
vi.mock('../../../kit', async () => {
  const { createElement: h } = await import('react');
  return {
    Screen: (p: any) => h('div', null, p.children), Header: (p: any) => h('header', null, p.title),
    Card: (p: any) => h('article', null, p.children), T: (p: any) => h('span', null, p.children),
    Chip: (p: any) => h('button', { onClick: p.onPress }, p.label),
    PillButton: (p: any) => h('button', { onClick: p.onPress }, p.label),
    EmptyState: (p: any) => h('section', null, p.title), ErrorState: () => h('div', null, 'Error'), LoadingBlock: () => h('div', null, 'Loading'),
  };
});

import { JobHistoryScreen } from './JobHistoryScreen';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
const trip = (i: number) => ({ id: `t${i}`, status: 'DELIVERED', taxiDropoffAddress: `Stop ${i}`, totalAmount: 1000 });
const answer = (rows: unknown[], meta: Record<string, unknown>) =>
  ({ data: { data: rows, meta }, isLoading: false, isFetching: false, isError: false, isPlaceholderData: false, refetch: vi.fn() });
async function render() {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(JobHistoryScreen, { navigation: {} })));
}
beforeEach(() => { fx.keys = []; fx.refresh = null; fx.invalidate.mockClear(); });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined;
});

describe('[APP-SPEED C] the trip history is a virtualised list', () => {
  it('every trip is a FlatList row with its own key, never mounted in a ScrollView; Load more under them', async () => {
    fx.q = answer(Array.from({ length: 20 }, (_, i) => trip(i + 1)), { page: 1, total: 45, hasNext: true });
    await render();
    const list = host.querySelector('[data-rn="flatlist"]');
    expect(list, 'the history is a FlatList').not.toBeNull();
    expect(fx.keys).toEqual(Array.from({ length: 20 }, (_, i) => `t${i + 1}`));
    expect(list!.querySelectorAll('article')).toHaveLength(20);
    for (const scroll of host.querySelectorAll('[data-rn="scroll"]')) expect(scroll.querySelectorAll('article')).toHaveLength(0);
    expect(list!.textContent).toContain('45 trips');
    expect(list!.textContent).toContain('Load more (20 of 45)');
  });

  it('a failed first read is the failure (never "No trips yet"), and no rows are drawn', async () => {
    fx.q = { data: undefined, isLoading: false, isFetching: false, isError: true, isPlaceholderData: false, refetch: vi.fn() };
    await render();
    expect(host.textContent).toContain('Error');
    expect(host.textContent).not.toContain('No trips yet');
    expect(fx.keys).toEqual([]);
  });

  it('a confirmed empty history says so; the pull still goes back to page 1 and re-reads the history family', async () => {
    fx.q = answer([], { page: 1, total: 0, hasNext: false });
    await render();
    expect(host.textContent).toContain('No trips yet');
    expect(fx.refresh).toBeTypeOf('function');
    await act(async () => { fx.refresh!(); });
    expect(fx.invalidate).toHaveBeenCalledWith({ queryKey: ['mover', 'history', 'DRIVER'] });
  });
});
