/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// [APP-SPEED 11] useScreenLive: the screen is shown AND Swift is in the foreground — the one gate Home's timers,
// measuring loops and video follow.

const fx = vi.hoisted(() => ({
  focused: true,
  state: 'active' as string,
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() { return fx.state; },
    addEventListener: (_event: string, cb: (state: string) => void) => { fx.listeners.add(cb); return { remove: () => fx.listeners.delete(cb) }; },
  },
}));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => fx.focused }));

import { appStateLive, useScreenLive } from './useScreenLive';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let live: boolean | undefined;
function Probe() { live = useScreenLive(); return null; }
const draw = async () => { await act(async () => root.render(h(Probe))); };
const appGoes = async (state: string) => { fx.state = state; await act(async () => { fx.listeners.forEach((cb) => cb(state)); }); };

beforeEach(() => {
  fx.focused = true; fx.state = 'active'; fx.listeners.clear(); live = undefined;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[APP-SPEED 11] useScreenLive', () => {
  it('foreground means active (or not known yet at start); background and inactive are not', () => {
    expect(appStateLive('active')).toBe(true);
    expect(appStateLive('unknown')).toBe(true);
    expect(appStateLive(null)).toBe(true);
    expect(appStateLive('background')).toBe(false);
    expect(appStateLive('inactive')).toBe(false);
  });

  it('live while focused in the foreground; not while blurred; not in the background; back on return', async () => {
    await draw();
    expect(live).toBe(true);
    fx.focused = false;
    await draw();
    expect(live).toBe(false);
    fx.focused = true;
    await draw();
    expect(live).toBe(true);
    await appGoes('background');
    expect(live).toBe(false);
    await appGoes('active');
    expect(live).toBe(true);
  });

  it('opened while Swift is in the background: not live until it comes back', async () => {
    fx.state = 'background';
    await draw();
    expect(live).toBe(false);
    await appGoes('active');
    expect(live).toBe(true);
  });

  it('leaves no listener behind', async () => {
    await draw();
    expect(fx.listeners.size).toBe(1);
    await act(async () => root.unmount());
    expect(fx.listeners.size).toBe(0);
    root = createRoot(host);
  });
});
