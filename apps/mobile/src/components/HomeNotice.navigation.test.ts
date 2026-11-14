/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [HOME-NOTICE ROUND 2 · REVIEW-B S3-1 / S4-3] The phone's Home notice, rendered
// (not read as source): it shows the owner's words, X closes it and the close is
// remembered; and a notice the owner turned off leaves the phone soon: Home
// re-reads it when the person comes back to Home or back to the app (once the
// answer is a minute old), and every 5 minutes only while Home is in front.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ get: vi.fn(), closed: [] as string[] }));

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const View = (p: any) => h('div', { role: p.accessibilityRole }, p.children);
  const Pressable = (p: any) => h('button', { 'aria-label': p.accessibilityLabel, onClick: p.onPress }, p.children);
  return { View, Pressable };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: { brand: {}, surface: {}, text: {} }, radius: {}, space: {} }));
vi.mock('../kit', async () => {
  const { createElement: h } = await import('react');
  return { T: (p: any) => h('span', null, p.children) };
});
vi.mock('../kit/touch-target', () => ({ touchTarget: () => ({}) }));
vi.mock('../services/api', () => ({ api: { get: fx.get } }));
vi.mock('../lib/homeNoticeMemory', () => ({
  closedHomeNoticeIds: () => [...fx.closed],
  rememberHomeNoticeClosed: (id: string) => { fx.closed.push(id); },
}));

import { HomeNotice, NOTICE_RECHECK_MS } from './HomeNotice';

const NOTICE = { id: 'abcdef0123456789', title: 'Pickup is open on Swift', body: 'Choose Pickup at checkout.', updatedAt: '2026-11-14T10:00:00.000Z' };
let live: unknown = NOTICE;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fx.closed = [];
  live = NOTICE;
  fx.get.mockReset().mockImplementation(async () => ({ data: { success: true, data: { notice: live } } }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove(); root = undefined; client.clear();
  vi.useRealTimers();
});
const draw = async (screenLive: boolean) => {
  await act(async () => root!.render(React.createElement(QueryClientProvider, { client }, React.createElement(HomeNotice, { gutter: 16, live: screenLive }))));
};
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const reads = () => fx.get.mock.calls.length;

describe('[HOME-NOTICE] the notice on the phone\'s Home', () => {
  it('shows the words; X closes it and the close is remembered', async () => {
    await draw(true);
    await settle();
    expect(host.textContent).toContain(NOTICE.body);
    expect(fx.get).toHaveBeenCalledWith('/public/home-notice');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close notice"]')!.click());
    expect(host.textContent).not.toContain(NOTICE.body);
    expect(fx.closed).toEqual([NOTICE.id]);
  });

  it('a notice closed before is never drawn', async () => {
    fx.closed = [NOTICE.id];
    await draw(true);
    await settle();
    expect(reads()).toBe(1);
    expect(host.textContent).not.toContain(NOTICE.body);
  });
});

describe('[ROUND 2] a notice turned off leaves the phone', () => {
  it('back on Home (or back to the app) after a minute: Home re-reads it, and an off notice is gone', async () => {
    await draw(true);
    await settle();
    expect(host.textContent).toContain(NOTICE.body);
    await draw(false); // another tab, or the phone in a pocket
    live = null; // the owner pressed "Turn off now"
    vi.setSystemTime(Date.now() + 61_000);
    await draw(true);
    await settle();
    expect(reads()).toBe(2);
    expect(host.textContent).not.toContain(NOTICE.body);
  });

  it('back within the minute: no extra read (the answer is still fresh)', async () => {
    await draw(true);
    await settle();
    await draw(false);
    await draw(true);
    await settle();
    expect(reads()).toBe(1);
  });

  it('every 5 minutes while Home is in front; none while it is not', async () => {
    expect(NOTICE_RECHECK_MS).toBe(5 * 60_000);
    await draw(true);
    await settle();
    live = null;
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTICE_RECHECK_MS + 1_000); });
    expect(reads()).toBe(2);
    expect(host.textContent).not.toContain(NOTICE.body);
    await draw(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * NOTICE_RECHECK_MS); });
    expect(reads()).toBe(2);
  });
});
