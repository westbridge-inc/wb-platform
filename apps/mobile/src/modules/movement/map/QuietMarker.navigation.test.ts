/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// [APP-SPEED C · report item 8] A pin drawn with SVG keeps tracksViewChanges on only while it first draws, then off;
// a new look (the car fading) draws it again the same way. The real QuietMarker over a stand-in map Marker.
const fx = vi.hoisted(() => ({ tracks: [] as unknown[] }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  return { Marker: (p: any) => { fx.tracks.push(p.tracksViewChanges); return R.createElement('i', { 'data-tracks': String(p.tracksViewChanges) }); } };
});

import { MARKER_SETTLE_MS, QuietMarker } from './QuietMarker';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const tracks = () => host.querySelector('i')?.getAttribute('data-tracks');
const draw = async (look: string) => {
  await act(async () => root.render(React.createElement(QuietMarker, { coordinate: { latitude: 6.8, longitude: -58.16 }, look })));
};

beforeEach(() => {
  vi.useFakeTimers();
  fx.tracks = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('QuietMarker', () => {
  it('draws while its view first paints, then stops tracking the view', async () => {
    await draw('live');
    expect(tracks()).toBe('true');
    await act(async () => { vi.advanceTimersByTime(MARKER_SETTLE_MS); });
    expect(tracks()).toBe('false');
  });

  it('a new look is drawn again the same way; the same look redrawn stays quiet', async () => {
    await draw('live');
    await act(async () => { vi.advanceTimersByTime(MARKER_SETTLE_MS); });
    await draw('live');
    expect(tracks()).toBe('false');
    await draw('faded');
    expect(tracks()).toBe('true');
    await act(async () => { vi.advanceTimersByTime(MARKER_SETTLE_MS); });
    expect(tracks()).toBe('false');
  });
});
