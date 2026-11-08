/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [BUG-RATING-SHAKE · owner 8 Nov 2026] "When I did the rating and sent it to the store, the app went crazy, it
// shook the screen up and down." Typing a comment and tapping Submit opened the thanks card while the keyboard still
// belonged to the comment box on the screen below. On Android the card's 'height' keyboard layer then resized on
// every keyboard event, each resize flipped what the screen below reported (keyboard shown / hidden), and that
// resized the layer again: 60 frames a second for as long as the card stayed open (with no input: 602 frames in
// 10 s; the same card opened with no field focused: 0). "Clear your cart?" over the focused promo field did the same.
//
// The card now puts that keyboard away first and opens once it has gone (or after KEYBOARD_GONE_MS), so its own
// fields mount afterwards and keep the keyboard THEY open, lifted above it.
//
// Rendered with real React. React Native is a stand-in that keeps the order of events: which field has focus, the
// keyboard, and a keyboard layer that behaves like React Native's on Android (it listens and resizes). The device's
// feedback is modelled as measured: while the keyboard belongs to a field BELOW the card, every resize of the layer
// flips the next keyboard report.
// ---------------------------------------------------------------------------

type KeyboardEvent = 'keyboardDidShow' | 'keyboardDidHide';

const fx = vi.hoisted(() => ({
  os: 'android' as 'android' | 'ios',
  keyboardUp: false,
  /** The field holding focus: 'below' is one on the screen under the card. */
  focused: null as string | null,
  listeners: new Set<{ name: KeyboardEvent; fn: () => void }>(),
  /** Keyboard events the platform delivers on the next frame. */
  pending: [] as KeyboardEvent[],
  /** What happened, in order. */
  log: [] as string[],
  layerResizes: 0,
  dismissals: 0,
  /** dismiss() hides the keyboard but says so only when the test delivers keyboardDidHide. */
  reportHide: true,
}));

const foreignKeyboard = () => fx.keyboardUp && fx.focused === 'below';

vi.mock('react-native', async () => {
  const R = await import('react');
  const Keyboard = {
    isVisible: () => fx.keyboardUp,
    dismiss: () => {
      fx.dismissals += 1;
      fx.log.push(`dismiss(${fx.focused ?? '-'})`);
      fx.focused = null;
      if (fx.keyboardUp) {
        fx.keyboardUp = false;
        if (fx.reportHide) fx.pending.push('keyboardDidHide');
      }
    },
    addListener: (name: KeyboardEvent, fn: () => void) => {
      const entry = { name, fn };
      fx.listeners.add(entry);
      return { remove: () => fx.listeners.delete(entry) };
    },
  };
  function KeyboardAvoidingView({ children }: { children?: React.ReactNode }) {
    const [bottom, setBottom] = R.useState(0);
    R.useEffect(() => {
      fx.log.push('layer');
      const show = Keyboard.addListener('keyboardDidShow', () => setBottom(96));
      const hide = Keyboard.addListener('keyboardDidHide', () => setBottom(0));
      return () => { show.remove(); hide.remove(); };
    }, []);
    const first = R.useRef(true);
    R.useEffect(() => {
      if (first.current) { first.current = false; return; }
      fx.layerResizes += 1;
      if (foreignKeyboard()) fx.pending.push(bottom > 0 ? 'keyboardDidHide' : 'keyboardDidShow');
    }, [bottom]);
    return R.createElement('div', { 'data-layer': 'kav', 'data-bottom': bottom }, children);
  }
  /** A field: autoFocus takes focus on mount and opens the keyboard for itself. */
  function TextInput({ id, autoFocus }: { id: string; autoFocus?: boolean }) {
    R.useLayoutEffect(() => {
      fx.log.push(`mount(${id})`);
      if (!autoFocus) return;
      fx.focused = id;
      fx.log.push(`focus(${id})`);
      if (!fx.keyboardUp) {
        fx.keyboardUp = true;
        fx.pending.push('keyboardDidShow');
      }
    }, []);
    return R.createElement('input', { 'data-field': id });
  }
  const host = (name: string) => ({ children }: { children?: React.ReactNode }) => R.createElement('div', { 'data-host': name }, children);
  return {
    Keyboard,
    KeyboardAvoidingView,
    Modal: ({ visible, children }: { visible: boolean; children?: React.ReactNode }) =>
      (visible ? R.createElement('div', { 'data-modal': 'open' }, children) : null),
    Platform: { get OS() { return fx.os; } },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    TextInput,
    View: host('View'),
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 24, left: 0 }) }));
vi.mock('@swift/ui', () => ({
  color: { surface: { base: '#fff' } },
  radius: { lg: 16, xl: 20 },
  space: { lg: 16, '2xl': 24 },
  elevation: { card: {} },
}));
vi.mock('./text', () => ({ T: () => null }));

import { KEYBOARD_GONE_MS, PopupCard } from './card';
import { KeyboardAvoidingView as LayerStandIn, TextInput } from 'react-native';

let cardDraws = 0;
function ThanksBody(): null {
  cardDraws += 1;
  return null;
}
/** The step-up card: a code field that takes focus as it appears, and Confirm under it. */
function StepUpBody() {
  return React.createElement(React.Fragment, null,
    React.createElement(TextInput as unknown as React.FC<{ id: string; autoFocus?: boolean }>, { id: 'code', autoFocus: true }),
    React.createElement('button', null, 'Confirm'));
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** One frame: the platform delivers the keyboard events queued for it. */
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const now = fx.pending.splice(0);
    await act(async () => {
      for (const e of now) [...fx.listeners].filter((l) => l.name === e).forEach((l) => l.fn());
    });
  }
}

const card = (visible: boolean, body: React.FC) =>
  React.createElement(PopupCard, { visible, onClose: () => {}, children: React.createElement(body) });
async function show(visible: boolean, body: React.FC = ThanksBody): Promise<void> {
  await act(async () => root.render(card(visible, body)));
}
const open = () => host.querySelector('[data-modal="open"]') !== null;
const layer = () => host.querySelector('[data-layer="kav"]');

beforeEach(() => {
  Object.assign(fx, { os: 'android', keyboardUp: false, focused: null, pending: [], log: [], layerResizes: 0, dismissals: 0, reportHide: true });
  fx.listeners.clear();
  cardDraws = 0;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe('[BUG-RATING-SHAKE] a card waits for another screen’s keyboard to go, then opens (Android)', () => {
  it('the stand-in is the loop: a keyboard layer over the keyboard of a field below resizes on every frame', async () => {
    // What the card did before (it opened at once, its layer over the comment box's keyboard).
    fx.focused = 'below';
    fx.keyboardUp = true;
    await act(async () => root.render(React.createElement(LayerStandIn as unknown as React.FC<{ children?: React.ReactNode }>, null, React.createElement(ThanksBody))));
    fx.pending.push('keyboardDidShow');
    await frames(120);
    expect(fx.layerResizes).toBe(120);
    expect(fx.pending).toHaveLength(1); // still going
  });

  it('the thanks card over the comment box’s keyboard: put away first, opens on keyboardDidHide, then stays still', async () => {
    fx.focused = 'below';
    fx.keyboardUp = true;
    await show(true);
    // Waiting, closed: nothing of the card is mounted; the keyboard below was put away.
    expect(open()).toBe(false);
    expect(cardDraws).toBe(0);
    expect(fx.log).toEqual(['dismiss(below)']);
    await frames(1); // keyboardDidHide
    expect(open()).toBe(true);
    expect(layer()).not.toBeNull(); // the keyboard layer is always there once open
    const drawsAfterOpen = cardDraws;
    await frames(120);
    expect(fx.layerResizes).toBe(0);
    expect(cardDraws).toBe(drawsAfterOpen);
    expect(fx.pending).toEqual([]);
    expect(fx.dismissals).toBe(1);
  });

  it('no keyboardDidHide (it never says so): opens after the fallback', async () => {
    vi.useFakeTimers();
    fx.focused = 'below';
    fx.keyboardUp = true;
    fx.reportHide = false;
    await show(true);
    expect(open()).toBe(false);
    await act(async () => { vi.advanceTimersByTime(KEYBOARD_GONE_MS - 1); });
    expect(open()).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(open()).toBe(true);
    expect(layer()).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('step-up over a focused form: the form’s keyboard goes, the code field mounts after, keeps focus, and is lifted', async () => {
    fx.focused = 'below'; // the form field (personal data, account, branch) the person was typing in
    fx.keyboardUp = true;
    await show(true, StepUpBody);
    expect(host.querySelector('[data-field="code"]')).toBeNull();
    await frames(1); // keyboardDidHide → open → the code field mounts and opens its own keyboard
    await frames(1); // keyboardDidShow (the card's own)
    expect(fx.log).toEqual(['dismiss(below)', 'mount(code)', 'focus(code)', 'layer']);
    expect(fx.focused).toBe('code'); // its own keyboard was never put away
    expect(fx.dismissals).toBe(1);
    expect(layer()?.getAttribute('data-bottom')).toBe('96'); // Confirm and the error line sit above the keyboard
    await frames(60);
    expect(fx.layerResizes).toBe(1);
    expect(fx.pending).toEqual([]);
  });

  it('closed while waiting: never opens, and the listener and the timer are gone', async () => {
    vi.useFakeTimers();
    fx.focused = 'below';
    fx.keyboardUp = true;
    fx.reportHide = false;
    await show(true);
    expect(fx.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await show(false);
    expect(fx.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(KEYBOARD_GONE_MS * 3); });
    fx.pending.push('keyboardDidHide');
    await frames(1);
    expect(open()).toBe(false);
    expect(cardDraws).toBe(0);
  });

  it('unmounted while waiting: the listener and the timer are gone', async () => {
    vi.useFakeTimers();
    fx.focused = 'below';
    fx.keyboardUp = true;
    fx.reportHide = false;
    await show(true);
    await act(async () => root.unmount());
    expect(fx.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(host); // afterEach unmounts again
  });

  it('no keyboard up (a hardware keyboard shows none): opens at once, nothing put away', async () => {
    await show(true);
    expect(open()).toBe(true);
    expect(fx.dismissals).toBe(0);
  });

  it('a keyboard the open card’s own field opens later is never waited for or put away', async () => {
    await show(true, StepUpBody);
    await frames(1);
    await show(true, StepUpBody); // a redraw of the same open card with its keyboard up
    expect(open()).toBe(true);
    expect(fx.dismissals).toBe(0);
    expect(fx.focused).toBe('code');
  });

  it('iOS is unchanged: opens at once over a keyboard', async () => {
    fx.os = 'ios';
    fx.focused = 'below';
    fx.keyboardUp = true;
    await show(true);
    expect(open()).toBe(true);
    expect(fx.dismissals).toBe(0);
  });
});
