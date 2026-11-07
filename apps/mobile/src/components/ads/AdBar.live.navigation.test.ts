/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-SPEED 11] The rotating ad bar on Home (the REAL AdBar in a real React renderer, native leaves mocked).
// Before: it turned every rotationSeconds and measured itself twice a second for as long as Home was mounted — under
// every other tab and screen, and with the phone in a pocket (Home is never frozen). Now both run only while Home is
// live (shown, Swift in the foreground), and start again when it is.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ scrolls: [] as number[], measures: 0 }));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = R.forwardRef((p: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({
      measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => { fx.measures += 1; cb(0, 0, 300, 92); },
    }));
    return R.createElement('div', null, p.children);
  });
  const FlatList = R.forwardRef((p: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({ scrollToIndex: ({ index }: { index: number }) => { fx.scrolls.push(index); } }));
    return R.createElement('div', null, (p.data ?? []).map((item: any, i: number) => R.createElement(R.Fragment, { key: i }, p.renderItem({ item, index: i }))));
  });
  return {
    View, FlatList, Pressable: (p: any) => R.createElement('div', null, p.children),
    StyleSheet: { create: (s: unknown) => s, absoluteFill: {} },
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
  };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@swift/ui', () => {
  const token: any = new Proxy({}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, radius: token, space: token };
});
vi.mock('../../kit', () => ({ T: () => null }));
vi.mock('./AdChip', () => ({ AdChip: () => null }));
vi.mock('../../lib/ads', () => ({ trackAdEvent: vi.fn(), openAdDestination: vi.fn() }));

import { AdBar } from './AdBar';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const items = ['a', 'b', 'c'].map((id) => ({
  creativeId: id, impressionToken: `t-${id}`, mediaUrl: `https://x/${id}.jpg`, advertiserName: 'Ad', headline: null, destination: null,
})) as any[];
const draw = async (live: boolean) => {
  await act(async () => root.render(h(AdBar, { items, rotationSeconds: 4, trackable: true, trackingScope: null, width: 300, live })));
};
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  fx.scrolls = [];
  fx.measures = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('[APP-SPEED 11] the ad bar turns only while Home is live', () => {
  it('turns and measures while live', async () => {
    await draw(true);
    await wait(4000);
    expect(fx.scrolls).toEqual([1]);
    expect(fx.measures).toBe(8);
  });

  it('nothing turns or measures while Home is under another screen or in the background; it starts again on return', async () => {
    await draw(true);
    await wait(4000);
    await draw(false);
    const at = { scrolls: fx.scrolls.length, measures: fx.measures };
    await wait(60_000);
    expect(fx.scrolls.length).toBe(at.scrolls);
    expect(fx.measures).toBe(at.measures);
    await draw(true);
    await wait(4000);
    expect(fx.scrolls.length).toBe(at.scrolls + 1);
    expect(fx.measures).toBe(at.measures + 8);
  });
});
