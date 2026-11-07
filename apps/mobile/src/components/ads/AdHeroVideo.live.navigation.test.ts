/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-SPEED 11] Home's hero video (the REAL AdHeroVideo in a real React renderer; the player is a stand-in).
// Before: Home is never frozen, so a playing hero went on playing (and downloading) under every other tab and screen,
// and with Swift in the background; the measuring loop that pauses it went on too, and a 0×0 measure (Home's tab
// detached) never told it to pause. Now: leaving Home or the foreground stops it at once and stops the loop; on return
// the loop plays it again only if it is in sight.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  rect: { x: 0, y: 0, w: 300, h: 200 },
  measures: 0,
  player: { playing: false, muted: true, loop: false, timeUpdateEventInterval: 0, duration: 30, play: vi.fn(), pause: vi.fn(), addListener: () => ({ remove: () => {} }) },
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = R.forwardRef((p: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({
      measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => {
        fx.measures += 1;
        cb(fx.rect.x, fx.rect.y, fx.rect.w, fx.rect.h);
      },
    }));
    return R.createElement('div', null, p.children);
  });
  return {
    View, Pressable: (p: any) => R.createElement('div', null, p.children),
    StyleSheet: { create: (s: unknown) => s, absoluteFill: {} },
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
  };
});
vi.mock('./videoModule', () => ({ videoModule: { useVideoPlayer: () => fx.player, VideoView: () => null } }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => {
  const token: any = new Proxy({}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, radius: token, space: token };
});
vi.mock('../../kit', () => ({ T: () => null }));
vi.mock('./AdChip', () => ({ AdChip: () => null }));
vi.mock('../../lib/ads', () => ({ trackAdEvent: vi.fn(), openAdDestination: vi.fn() }));

import { AdHeroVideo } from './AdHeroVideo';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const item = { creativeId: 'v', kind: 'VIDEO', impressionToken: 't-v', mediaUrl: 'https://x/v.mp4', posterUrl: 'https://x/v.jpg', advertiserName: 'Ad', headline: null, destination: null } as any;
const draw = async (live: boolean) => { await act(async () => root.render(h(AdHeroVideo, { item, trackable: true, trackingScope: null, live }))); };
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  fx.rect = { x: 0, y: 0, w: 300, h: 200 };
  fx.measures = 0;
  fx.player.playing = false;
  fx.player.play.mockReset().mockImplementation(() => { fx.player.playing = true; });
  fx.player.pause.mockReset().mockImplementation(() => { fx.player.playing = false; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('[APP-SPEED 11] the hero video plays only while Home is in front of the person', () => {
  it('in sight on a live Home: it plays', async () => {
    await draw(true);
    await wait(500);
    expect(fx.player.play).toHaveBeenCalledOnce();
    expect(fx.player.playing).toBe(true);
  });

  it('leaving Home (or the foreground) pauses it at once and stops measuring; back in sight on return, it plays again', async () => {
    await draw(true);
    await wait(500);
    await draw(false);
    expect(fx.player.pause).toHaveBeenCalledOnce();
    expect(fx.player.playing).toBe(false);
    const measured = fx.measures;
    await wait(30_000);
    expect(fx.measures).toBe(measured);
    expect(fx.player.play).toHaveBeenCalledOnce();
    await draw(true);
    await wait(500);
    expect(fx.player.play).toHaveBeenCalledTimes(2);
  });

  it('back on Home but scrolled out of sight: it stays paused', async () => {
    await draw(true);
    await wait(500);
    await draw(false);
    fx.rect = { x: 0, y: 2000, w: 300, h: 200 };
    await draw(true);
    await wait(2000);
    expect(fx.player.play).toHaveBeenCalledOnce();
    expect(fx.player.playing).toBe(false);
  });

  it('measured at 0×0 (its tab detached) while playing: it pauses', async () => {
    await draw(true);
    await wait(500);
    fx.rect = { x: 0, y: 0, w: 0, h: 0 };
    await wait(500);
    expect(fx.player.pause).toHaveBeenCalledOnce();
    expect(fx.player.playing).toBe(false);
  });
});
