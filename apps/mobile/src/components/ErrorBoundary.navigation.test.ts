/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-INTRO · review] App.tsx hides the native splash from the root view's onLayout. The root ErrorBoundary sits
// OUTSIDE that view: when anything below it throws before the first layout, its recovery screen replaces the view,
// onLayout never runs, and the splash would stay up for good, over a recovery screen nobody can see. That is the
// fresh-install path an App Store reviewer takes. The boundary now hides the splash itself.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ splashHides: 0, crashes: [] as Array<{ message: string; source: unknown }>, broken: true }));

vi.mock('react-native', async () => {
  const R = await import('react');
  return {
    View: ({ children }: any) => R.createElement('div', null, children),
    Text: ({ children }: any) => R.createElement('span', null, children),
    Pressable: ({ children, onPress, accessibilityRole }: any) => R.createElement('div', { role: accessibilityRole, onClick: () => onPress?.() }, children),
  };
});
vi.mock('@swift/ui', () => {
  const token: unknown = new Proxy({}, { get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, font: token };
});
vi.mock('expo-splash-screen', () => ({ hideAsync: async () => { fx.splashHides += 1; } }));
vi.mock('../lib/crash-reporter', () => ({
  reportCrash: (error: Error, context?: { source?: unknown }) => { fx.crashes.push({ message: error.message, source: context?.source }); },
}));

import { ErrorBoundary } from './ErrorBoundary';
import { introDecidedThisSession, resetIntroSessionForTests } from '../lib/launchIntro';

/** The app's first screen; it throws on its first render while `broken` is set. */
function FirstScreen() {
  if (fx.broken) throw new Error('first render failed');
  return React.createElement('div', { 'data-testid': 'first-screen' }, 'Welcome to Swift');
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(fx, { splashHides: 0, crashes: [], broken: true });
  resetIntroSessionForTests();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('[APP-INTRO · review] the root ErrorBoundary never leaves the native splash up', () => {
  it('a throw before the first layout: the splash is hidden, the recovery screen is usable, Try again recovers', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => root.render(React.createElement(ErrorBoundary, null, React.createElement(FirstScreen))));
    quiet.mockRestore();
    expect(host.textContent).toContain('Something went wrong');
    expect(fx.splashHides, 'the boundary hid the splash itself').toBe(1);
    expect(fx.crashes).toEqual([{ message: 'first render failed', source: 'boundary' }]);
    // [APP-INTRO · review 2] "Try again" remounts everything: the brand intro is not played again this session.
    expect(introDecidedThisSession()).toBe(true);

    // The recovery screen is usable: Try again renders the app again.
    fx.broken = false;
    await act(async () => { (host.querySelector('[role="button"]') as HTMLElement).click(); });
    expect(host.querySelector('[data-testid="first-screen"]')).not.toBeNull();
  });

  it('nothing thrown: the boundary leaves the splash to the root view, as before', async () => {
    fx.broken = false;
    await act(async () => root.render(React.createElement(ErrorBoundary, null, React.createElement(FirstScreen))));
    expect(host.querySelector('[data-testid="first-screen"]')).not.toBeNull();
    expect(fx.splashHides).toBe(0);
    expect(introDecidedThisSession(), 'no crash: the intro decides for itself').toBe(false);
  });
});
