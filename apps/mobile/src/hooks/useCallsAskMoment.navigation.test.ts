/// <reference lib="dom" />
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { CALLS_ASK_AFTER_DRAW_MS, useCallsAskMoment } from './useCallsAskMoment';
import { callsAskMomentOpen, onCallsAskMoment, resetCallsAskMomentsForTests } from '../services/inAppReach';

// [CALLS-REACH · review S2-2] The Android microphone is asked only on an order-tracking, active-job or store-board
// screen, after it has drawn, while it is the one in front on a live order.

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Probe({ shown }: { shown: boolean }) { useCallsAskMoment(shown); return null; }
const draw = async (shown: boolean) => { await act(async () => root.render(h(Probe, { shown }))); };

beforeEach(() => {
  vi.useFakeTimers();
  resetCallsAskMomentsForTests();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('[CALLS-REACH] useCallsAskMoment', () => {
  it('opens a beat after the screen has drawn, tells the app-wide layer, and closes when the screen is left', async () => {
    const opened = vi.fn();
    onCallsAskMoment(opened);
    await draw(true);
    expect(callsAskMomentOpen()).toBe(false); // never over a screen still opening
    await act(async () => { vi.advanceTimersByTime(CALLS_ASK_AFTER_DRAW_MS); });
    expect(callsAskMomentOpen()).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    await draw(false); // covered, blurred, or Swift in the background
    expect(callsAskMomentOpen()).toBe(false);
  });

  it('a screen left before it settled never opens one; unmount closes it', async () => {
    await draw(true);
    await draw(false);
    await act(async () => { vi.advanceTimersByTime(CALLS_ASK_AFTER_DRAW_MS * 2); });
    expect(callsAskMomentOpen()).toBe(false);
    await draw(true);
    await act(async () => { vi.advanceTimersByTime(CALLS_ASK_AFTER_DRAW_MS); });
    expect(callsAskMomentOpen()).toBe(true);
    await act(async () => root.unmount());
    expect(callsAskMomentOpen()).toBe(false);
    root = createRoot(host);
  });

  it('only the four fitting screens open it: order tracking, the ride, the active job, the store board', () => {
    const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
    expect(src('../modules/orders/screens/DeliveryScreen.tsx')).toContain('useCallsAskMoment(screenLive && !!o && !isTerminalOrderSnapshot(o));');
    expect(src('../modules/movement/screens/TaxiScreen.tsx')).toContain('useCallsAskMoment(rideShown && !!ride?.id);');
    expect(src('../modules/mover/screens/ActiveJobScreen.tsx')).toContain('useCallsAskMoment(shown && !!liveJob);');
    expect(src('../modules/vendor/screens/VendorOps.tsx')).toContain("useCallsAskMoment(boardShown && reachSignal({ storeOrders: fetched }).state === 'live');");
    const dir = new URL('../', import.meta.url);
    const callers = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('useCallsAskMoment.ts'))
      .filter((f) => readFileSync(new URL(f, dir), 'utf8').includes('useCallsAskMoment('))
      .sort();
    expect(callers).toEqual([
      'modules/movement/screens/TaxiScreen.tsx',
      'modules/mover/screens/ActiveJobScreen.tsx',
      'modules/orders/screens/DeliveryScreen.tsx',
      'modules/vendor/screens/VendorOps.tsx',
    ]);
  });
});
