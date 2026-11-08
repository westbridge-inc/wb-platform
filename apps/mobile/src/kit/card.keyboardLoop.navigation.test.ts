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
// resized the layer again: 60 frames a second for as long as the card stayed open (measured with no input: 602
// frames in 10 s; the same card opened with no field focused: 0). "Clear your cart?" over the focused promo field
// did the same.
//
// Rendered with real React. The keyboard layer below is a stand-in that behaves like React Native's on Android: it
// listens to the keyboard and resizes (setState) on each event. The device's feedback is modelled the way it was
// measured: while the keyboard belongs to a field BELOW the card, every resize of the layer flips the keyboard
// event that follows. The test drives a fixed number of frames and counts the card's redraws.
// ---------------------------------------------------------------------------

type KeyboardEvent = 'keyboardDidShow' | 'keyboardDidHide';

const fx = vi.hoisted(() => ({
  os: 'android' as 'android' | 'ios',
  keyboardUp: false,
  /** The keyboard belongs to a field on the screen below the card (the owner's comment box). */
  foreignKeyboard: false,
  listeners: new Set<(e: KeyboardEvent) => void>(),
  /** Keyboard events the platform will deliver on the next frames. */
  pending: [] as KeyboardEvent[],
  layerResizes: 0,
  layersMounted: [] as string[],
  cardDraws: 0,
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const Keyboard = {
    isVisible: () => fx.keyboardUp,
    addListener: (_name: KeyboardEvent, listener: (e: KeyboardEvent) => void) => {
      const wrapped = (e: KeyboardEvent) => { if (e === _name) listener(e); };
      fx.listeners.add(wrapped);
      return { remove: () => fx.listeners.delete(wrapped) };
    },
  };
  function KeyboardAvoidingView({ children }: { children?: React.ReactNode }) {
    const [bottom, setBottom] = R.useState(0);
    R.useEffect(() => {
      fx.layersMounted.push('KeyboardAvoidingView');
      const show = Keyboard.addListener('keyboardDidShow', () => setBottom(96));
      const hide = Keyboard.addListener('keyboardDidHide', () => setBottom(0));
      return () => { show.remove(); hide.remove(); };
    }, []);
    const first = R.useRef(true);
    R.useEffect(() => {
      if (first.current) { first.current = false; return; }
      fx.layerResizes += 1;
      // The measured feedback: a resize while the keyboard belongs to the screen below flips its next report.
      if (fx.foreignKeyboard) fx.pending.push(bottom > 0 ? 'keyboardDidHide' : 'keyboardDidShow');
    }, [bottom]);
    return R.createElement('div', { 'data-layer': 'kav', 'data-bottom': bottom }, children);
  }
  function View({ children }: { children?: React.ReactNode }) {
    R.useEffect(() => { fx.layersMounted.push('View'); }, []);
    return R.createElement('div', null, children);
  }
  const host = (name: string) => ({ children }: { children?: React.ReactNode }) => R.createElement('div', { 'data-host': name }, children);
  return {
    Keyboard,
    KeyboardAvoidingView,
    Modal: ({ visible, children }: { visible: boolean; children?: React.ReactNode }) => (visible ? R.createElement('div', null, children) : null),
    Platform: { get OS() { return fx.os; } },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    View,
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

import { PopupCard } from './card';

function CardBody(): null {
  fx.cardDraws += 1;
  return null;
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** One frame: the platform delivers the keyboard events queued for it. */
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const now = fx.pending.splice(0);
    await act(async () => { for (const e of now) fx.listeners.forEach((l) => l(e)); });
  }
}

async function openCard(): Promise<void> {
  await act(async () => root.render(React.createElement(PopupCard, { visible: true, onClose: () => {}, children: React.createElement(CardBody) })));
}

beforeEach(() => {
  Object.assign(fx, { os: 'android', keyboardUp: false, foreignKeyboard: false, pending: [], layerResizes: 0, layersMounted: [], cardDraws: 0 });
  fx.listeners.clear();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('[BUG-RATING-SHAKE] a card opened over another screen’s keyboard stays still (Android)', () => {
  it('the thanks card over the comment box’s keyboard: no keyboard layer, no redraws over 120 frames', async () => {
    fx.keyboardUp = true;
    fx.foreignKeyboard = true;
    await openCard();
    const drawsAfterOpen = fx.cardDraws;
    // A keyboard report from the screen below reaches the open card (what set the device's loop going).
    fx.pending.push('keyboardDidShow');
    await frames(120);
    expect(fx.layersMounted).toEqual(['View']);
    expect(fx.layerResizes).toBe(0);
    expect(fx.cardDraws).toBe(drawsAfterOpen);
    expect(fx.pending).toEqual([]);
    expect(host.querySelector('[data-layer="kav"]')).toBeNull();
  });

  it('the stand-in is the loop: a keyboard layer over another screen’s keyboard resizes on every frame', async () => {
    // What the card did before this fix (it always mounted the layer), shown on the stand-in alone, so the
    // first case cannot pass by a stand-in that never loops.
    const { KeyboardAvoidingView } = await import('react-native');
    fx.keyboardUp = true;
    fx.foreignKeyboard = true;
    await act(async () => root.render(React.createElement(KeyboardAvoidingView as unknown as React.FC<{ children?: React.ReactNode }>, null, React.createElement(CardBody))));
    fx.pending.push('keyboardDidShow');
    await frames(120);
    // Every frame resizes the layer, and each resize queues the next flip.
    expect(fx.layerResizes).toBe(120);
    expect(fx.pending.length).toBe(1); // still going when the frames ran out
  });

  it('a card opened with no keyboard still follows the keyboard its own field opens, once, without a loop', async () => {
    await openCard();
    expect(fx.layersMounted).toEqual(['KeyboardAvoidingView']);
    fx.keyboardUp = true; // the card's own code field (emergency contact, step-up, relay)
    fx.pending.push('keyboardDidShow');
    await frames(60);
    expect(fx.layerResizes).toBe(1);
    expect(host.querySelector('[data-layer="kav"]')?.getAttribute('data-bottom')).toBe('96');
  });

  it('the answer is held while the card is open: the keyboard going away does not swap the layer under it', async () => {
    fx.keyboardUp = true;
    fx.foreignKeyboard = true;
    await openCard();
    fx.keyboardUp = false;
    await openCard(); // a redraw of the same open card (e.g. a parent re-render)
    expect(fx.layersMounted).toEqual(['View']);
    // Closed and opened again with no keyboard: a fresh answer.
    fx.foreignKeyboard = false;
    await act(async () => root.render(React.createElement(PopupCard, { visible: false, onClose: () => {}, children: null })));
    await openCard();
    expect(fx.layersMounted).toEqual(['View', 'KeyboardAvoidingView']);
  });

  it('iOS keeps its padding layer whatever was up when the card opened', async () => {
    fx.os = 'ios';
    fx.keyboardUp = true;
    await openCard();
    expect(fx.layersMounted).toEqual(['KeyboardAvoidingView']);
  });
});
