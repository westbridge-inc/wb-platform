/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-SPEED 11] The ad units' measuring loop (useAdViewability), the REAL hook in a real React renderer.
//
// Before: the loop measured twice a second for as long as Home was mounted — and Home is never frozen, so it went on
// under every other tab and screen and with the phone in a pocket. And a unit measured at 0×0 (Home's tab detached
// while another tab shows, a view not laid out) returned before saying anything: a hero video playing when Home was
// left was never told it was out of sight, so it never paused.
// Now: the loop runs only while the screen is live (focused, Swift in the foreground); a 0×0 measure is "not visible"
// (fraction 0); and the 1 s dwell for a viewable impression starts again after a pause (continuous, as the spec says).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  rect: { x: 0, y: 0, w: 300, h: 200 },
  measures: 0,
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
  return { View, Dimensions: { get: () => ({ width: 390, height: 844 }) } };
});

import { View } from 'react-native';
import { useAdViewability } from './useAdViewability';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const seen: number[] = [];
const viewable = vi.fn();

function Unit({ live, keep = true }: { live?: boolean; keep?: boolean }) {
  const { ref } = useAdViewability({
    enabled: true,
    keepMeasuring: keep,
    live,
    onViewable: viewable,
    onVisibility: (fraction) => { seen.push(fraction); },
  });
  return h(View as any, { ref });
}
const draw = async (props: { live?: boolean; keep?: boolean }) => { await act(async () => root.render(h(Unit, props))); };
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  fx.rect = { x: 0, y: 0, w: 300, h: 200 };
  fx.measures = 0;
  seen.length = 0;
  viewable.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('[APP-SPEED 11] the ad measuring loop', () => {
  it('a unit measured at 0×0 is out of sight: the video is told 0 (it pauses), never left playing', async () => {
    await draw({ live: true });
    await wait(500);
    expect(seen).toEqual([1]);
    fx.rect = { x: 0, y: 0, w: 0, h: 0 };
    await wait(500);
    expect(seen).toEqual([1, 0]);
  });

  it('measures nothing while the screen is not live, and starts again when it is', async () => {
    await draw({ live: false });
    await wait(5000);
    expect(fx.measures).toBe(0);
    await draw({ live: true });
    await wait(1000);
    expect(fx.measures).toBe(2);
    await draw({ live: false });
    await wait(5000);
    expect(fx.measures, 'the loop stops at the blur').toBe(2);
  });

  it('a screen without the gate (an older caller) keeps measuring as before', async () => {
    await draw({});
    await wait(1000);
    expect(fx.measures).toBe(2);
  });

  it('the 1 s dwell is continuous: half a dwell before a pause does not count after it', async () => {
    await draw({ live: true, keep: false });
    await wait(500);
    expect(viewable).not.toHaveBeenCalled();
    await draw({ live: false });
    await wait(3000);
    await draw({ live: true, keep: false });
    await wait(500);
    expect(viewable, 'one check after the pause is half the dwell').not.toHaveBeenCalled();
    await wait(500);
    expect(viewable).toHaveBeenCalledOnce();
  });

  it('a unit out of sight at 0×0 breaks the dwell too', async () => {
    await draw({ live: true, keep: false });
    await wait(500);
    fx.rect = { x: 0, y: 0, w: 0, h: 0 };
    await wait(500);
    fx.rect = { x: 0, y: 0, w: 300, h: 200 };
    await wait(500);
    expect(viewable).not.toHaveBeenCalled();
    await wait(500);
    expect(viewable).toHaveBeenCalledOnce();
  });
});
