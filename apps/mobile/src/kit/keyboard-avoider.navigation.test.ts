/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [ANDROID 9 Nov] KeyboardAvoider: the form view pads itself above the keyboard
// on Android, where the edge-to-edge window is never resized for it — including
// when the keyboard is ALREADY open as the screen mounts (sign-up after the OTP
// code: Android sends no new keyboardDidShow when focus moves between fields).
// Real component; react-native's Keyboard, Platform and View are stand-ins that
// keep RN's contracts: Keyboard.isVisible()/metrics() report the open keyboard
// (window coordinates), listeners get keyboardDidShow/keyboardDidHide on Android,
// and a View reports its frame (relative to its parent) through onLayout.
// ---------------------------------------------------------------------------

type Metrics = { screenX: number; screenY: number; width: number; height: number };
const fx = vi.hoisted(() => ({
  os: 'android' as 'android' | 'ios',
  open: null as Metrics | null,
  listeners: new Map<string, Set<(e: { endCoordinates: Metrics }) => void>>(),
  /** The frame every measured View reports: under a 120pt header, to the bottom of an 844pt screen. */
  frame: { x: 0, y: 120, width: 390, height: 724 },
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const flat = (style: unknown): Record<string, unknown> =>
    Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : ((style ?? {}) as Record<string, unknown>);
  const View = ({ children, style, onLayout, testID }: any) => {
    R.useLayoutEffect(() => { onLayout?.({ nativeEvent: { layout: fx.frame } }); }, []);
    const s = flat(style);
    return R.createElement('div', { 'data-testid': testID, 'data-padding-bottom': String(s['paddingBottom'] ?? 0), 'data-flex': String(s['flex'] ?? '') }, children);
  };
  const KeyboardAvoidingView = ({ children, behavior }: any) =>
    R.createElement('div', { 'data-role': 'rn-keyboard-avoiding-view', 'data-behavior': String(behavior) }, children);
  const Keyboard = {
    isVisible: () => fx.open != null,
    metrics: () => fx.open ?? undefined,
    addListener: (name: string, fn: (e: { endCoordinates: Metrics }) => void) => {
      if (!fx.listeners.has(name)) fx.listeners.set(name, new Set());
      fx.listeners.get(name)!.add(fn);
      return { remove: () => fx.listeners.get(name)!.delete(fn) };
    },
  };
  return { View, KeyboardAvoidingView, Keyboard, Platform: { get OS() { return fx.os; } } };
});

import { KeyboardAvoider, keyboardOverlap } from './keyboard-avoider';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fx.os = 'android';
  fx.open = null;
  fx.listeners.clear();
});

/** A phone keyboard whose top edge is at `top` (window coordinates). */
const keyboardAt = (top: number): Metrics => ({ screenX: 0, screenY: top, width: 390, height: 844 - top });
function emit(name: 'keyboardDidShow' | 'keyboardDidHide', metrics: Metrics) {
  for (const fn of [...(fx.listeners.get(name) ?? [])]) fn({ endCoordinates: metrics });
}
async function mount() {
  await act(async () => root.render(h(KeyboardAvoider, { style: { flex: 1 }, testID: 'form' }, h('input', { placeholder: 'Enter email' }))));
}
const form = () => host.querySelector('[data-testid="form"]')!;

describe('[ANDROID 9 Nov] KeyboardAvoider lifts the form above the keyboard on Android', () => {
  it('a keyboard already open when the screen mounts (OTP -> sign-up) lifts the form at once', async () => {
    fx.open = keyboardAt(520); // the OTP code's keyboard, still up
    await mount();
    // 120 + 724 = 844: the form's bottom; the keyboard starts at 520.
    expect(form().getAttribute('data-padding-bottom')).toBe('324');
    expect(form().contains(host.querySelector('input[placeholder="Enter email"]'))).toBe(true);
  });

  it('follows the keyboard as it opens and closes', async () => {
    await mount();
    expect(form().getAttribute('data-padding-bottom')).toBe('0');

    await act(async () => emit('keyboardDidShow', keyboardAt(500)));
    expect(form().getAttribute('data-padding-bottom')).toBe('344');

    await act(async () => emit('keyboardDidHide', keyboardAt(844)));
    expect(form().getAttribute('data-padding-bottom')).toBe('0');
  });

  it('keeps the screen\'s own style (flex: 1) under the padding', async () => {
    fx.open = keyboardAt(520);
    await mount();
    expect(form().getAttribute('data-flex')).toBe('1');
  });

  it('stops listening when the screen goes away', async () => {
    await mount();
    expect(fx.listeners.get('keyboardDidShow')?.size).toBe(1);
    await act(async () => root.unmount());
    expect(fx.listeners.get('keyboardDidShow')?.size).toBe(0);
    expect(fx.listeners.get('keyboardDidHide')?.size).toBe(0);
    root = createRoot(host);
  });
});

describe('iOS keeps React Native\'s own KeyboardAvoidingView', () => {
  it('renders RN KeyboardAvoidingView with behavior "padding" (what these screens already used on iOS)', async () => {
    fx.os = 'ios';
    await mount();
    const rn = host.querySelector('[data-role="rn-keyboard-avoiding-view"]');
    expect(rn).not.toBeNull();
    expect(rn!.getAttribute('data-behavior')).toBe('padding');
  });
});

describe('the padding is the part of the view the keyboard covers', () => {
  it('is never negative, and zero with no frame or no keyboard', () => {
    expect(keyboardOverlap({ y: 120, height: 724 }, { screenY: 520 })).toBe(324);
    expect(keyboardOverlap({ y: 0, height: 400 }, { screenY: 520 })).toBe(0);
    expect(keyboardOverlap(null, { screenY: 520 })).toBe(0);
    expect(keyboardOverlap({ y: 120, height: 724 }, null)).toBe(0);
  });
});
