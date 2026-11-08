/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-SPEED D] Home's service tiles are PressableScale, and their press-in
// now starts the door's read (hooks/homeDoors). A caller's onPressIn/onPressOut
// used to be spread AFTER the dip and so REPLACED it: the tile would have lost
// its press feedback the moment it learned to read ahead. Both must run.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ props: null as null | Record<string, any>, timings: [] as number[] }));

vi.mock('react-native', () => ({ Pressable: () => null }));
vi.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { createAnimatedComponent: () => (p: Record<string, any>) => { fx.props = p; return null; } },
  useSharedValue: (v: number) => ({ value: v }),
  useAnimatedStyle: (fn: () => unknown) => fn(),
  withTiming: (to: number) => { fx.timings.push(to); return to; },
}));
vi.mock('@swift/ui', () => ({ motion: { scale: { press: 0.98, pressStrong: 0.95 }, duration: { instant: 80, fast: 160 } } }));

import { PressableScale } from './pressable-scale';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { fx.props = null; fx.timings = []; host = document.createElement('div'); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); });

describe('[APP-SPEED D] PressableScale keeps its dip when the caller listens to the press too', () => {
  it('press-in dips AND calls the caller; press-out springs back AND calls the caller', async () => {
    const onPressIn = vi.fn();
    const onPressOut = vi.fn();
    await act(async () => root.render(React.createElement(PressableScale, { strong: true, onPressIn, onPressOut })));
    fx.props!['onPressIn']({});
    expect(fx.timings).toEqual([0.95]);
    expect(onPressIn).toHaveBeenCalledTimes(1);
    fx.props!['onPressOut']({});
    expect(fx.timings).toEqual([0.95, 1]);
    expect(onPressOut).toHaveBeenCalledTimes(1);
  });

  it('with no caller handlers, the dip alone', async () => {
    await act(async () => root.render(React.createElement(PressableScale, {})));
    fx.props!['onPressIn']({});
    fx.props!['onPressOut']({});
    expect(fx.timings).toEqual([0.98, 1]);
  });
});
