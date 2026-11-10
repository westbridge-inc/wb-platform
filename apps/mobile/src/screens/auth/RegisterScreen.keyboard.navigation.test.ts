/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [ANDROID 9 Nov] "Create your new account" on Android: with the keyboard open
// the form could not be scrolled down to the email field.
//
// The Android window is edge-to-edge (Expo SDK 56 / RN 0.85, mandatory), so the
// OS never shrinks it for the keyboard; only the screen's own keyboard-avoiding
// view can. The sign-up form passed `behavior={Platform.OS === 'ios' ? 'padding'
// : undefined}`, and RN's KeyboardAvoidingView with no behavior is a plain View
// that never moves (Libraries/Components/Keyboard/KeyboardAvoidingView.js,
// `default:`). Worse, sign-up opens straight from the OTP code with the keyboard
// still up, and Android sends no new keyboardDidShow when focus moves to First
// Name, so even 'padding' would start at 0 there.
//
// REAL: RegisterScreen and the kit KeyboardAvoider it now uses. Stand-ins keep
// RN's contracts: Keyboard reports the open keyboard (isVisible/metrics, window
// coordinates) and emits keyboardDidShow/Hide; a View reports its frame through
// onLayout; RN's KeyboardAvoidingView moves only for a real behavior.
// ---------------------------------------------------------------------------

type Metrics = { screenX: number; screenY: number; width: number; height: number };
const fx = vi.hoisted(() => ({
  os: 'android' as 'android' | 'ios',
  open: null as Metrics | null,
  listeners: new Map<string, Set<(e: { endCoordinates: Metrics }) => void>>(),
}));
/** The sign-up form view's frame: under the 120pt back-button header, to the bottom of an 844pt screen. */
const FORM_FRAME = { x: 0, y: 120, width: 390, height: 724 };
/** A Samsung-style keyboard (toolbar + number row) whose top edge is at y = 508. */
const KEYBOARD = { screenX: 0, screenY: 508, width: 390, height: 336 };

vi.mock('react-native', async () => {
  const R = await import('react');
  const kids = (children: unknown) =>
    (typeof children === 'function' ? (children as (s: { pressed: boolean }) => unknown)({ pressed: false }) : children) as React.ReactNode;
  const flat = (style: unknown): Record<string, unknown> =>
    Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : ((style ?? {}) as Record<string, unknown>);
  const View = ({ children, testID, style, onLayout }: any) => {
    R.useLayoutEffect(() => { onLayout?.({ nativeEvent: { layout: FORM_FRAME } }); }, []);
    return R.createElement('div', {
      'data-testid': testID,
      ...(onLayout ? { 'data-role': 'keyboard-avoiding', 'data-lifted-by': String(flat(style)['paddingBottom'] ?? 0) } : {}),
    }, kids(children));
  };
  const ScrollView = ({ children, keyboardShouldPersistTaps }: any) =>
    R.createElement('div', { 'data-role': 'scroll', 'data-persist-taps': keyboardShouldPersistTaps }, kids(children));
  const KeyboardAvoidingView = ({ children, behavior }: any) => {
    // RN: 'height' | 'position' | 'padding' move the view; anything else is a plain View.
    const moves = behavior === 'padding' || behavior === 'height' || behavior === 'position';
    return R.createElement('div', {
      'data-role': 'keyboard-avoiding',
      'data-behavior': String(behavior),
      'data-lifted-by': String(moves && fx.open ? FORM_FRAME.y + FORM_FRAME.height - fx.open.screenY : 0),
    }, children);
  };
  const Keyboard = {
    isVisible: () => fx.open != null,
    metrics: () => fx.open ?? undefined,
    addListener: (name: string, fn: (e: { endCoordinates: Metrics }) => void) => {
      if (!fx.listeners.has(name)) fx.listeners.set(name, new Set());
      fx.listeners.get(name)!.add(fn);
      return { remove: () => fx.listeners.get(name)!.delete(fn) };
    },
  };
  const Pressable = ({ children, onPress, testID }: any) =>
    R.createElement('div', { role: 'button', 'data-testid': testID, onClick: () => onPress?.() }, kids(children));
  return {
    View, ScrollView, KeyboardAvoidingView, Keyboard, Pressable, Text: View,
    TextInput: ({ placeholder }: any) => R.createElement('input', { placeholder, readOnly: true }),
    Platform: { get OS() { return fx.os; }, select: (o: any) => o[fx.os] ?? o.default },
  };
});
vi.mock('@tanstack/react-query', () => ({ useMutation: () => ({ mutate: vi.fn(), isError: false, isPending: false, error: null }) }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ reset: vi.fn() }),
  useRoute: () => ({ params: { phone: '+5920000000', registrationProof: 'proof' } }),
}));
vi.mock('@swift/ui', () => {
  const token: any = new Proxy({}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, space: token };
});
vi.mock('../../services/api', () => ({ authApi: { register: vi.fn() }, API_URL: 'https://api.example.test' }));
vi.mock('../../lib/payLink', () => ({ openPayLink: vi.fn() }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: () => ({ setAuth: vi.fn(), intent: 'customer', countryCode: 'GY' }) }));
vi.mock('../../components/SwiftLogo', () => ({ SwiftMark: () => null }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return {
    Screen: Box,
    Header: () => R.createElement('header', null, 'back'),
    T: ({ children }: any) => R.createElement('span', null, children),
    LabeledInput: ({ label, placeholder }: any) => R.createElement('label', null, label, R.createElement('input', { placeholder, readOnly: true })),
    BrandCheckbox: () => R.createElement('span', null, '[ ]'),
    PillButton: ({ label }: any) => R.createElement('button', { type: 'button' }, label),
  };
});

import { RegisterScreen } from './RegisterScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); fx.os = 'android'; fx.open = null; fx.listeners.clear(); });

const render = async () => { await act(async () => root.render(React.createElement(RegisterScreen))); };
const field = (placeholder: string) => {
  const input = host.querySelector(`input[placeholder="${placeholder}"]`);
  expect(input, `the "${placeholder}" field is on the form`).not.toBeNull();
  return input!;
};

/** The one keyboard-avoiding view: lifted by the keyboard's overlap, holding a scroll view with every field. */
function expectLiftedForm(os: string) {
  const avoiding = host.querySelectorAll('[data-role="keyboard-avoiding"]');
  expect(avoiding, `${os}: one keyboard-avoiding view`).toHaveLength(1);
  const kav = avoiding[0]!;
  // 120 + 724 = 844, the form's bottom; the keyboard's top edge is at 508.
  expect(kav.getAttribute('data-lifted-by'), `${os}: the form is padded by the part the keyboard covers`).toBe('336');
  // Every field lives in the scroll view INSIDE the lifted view, so the
  // shrunken scroll area can bring each one above the keyboard.
  const scroll = kav.querySelector('[data-role="scroll"]');
  expect(scroll, 'the form scrolls inside the keyboard-avoiding view').not.toBeNull();
  for (const placeholder of ['First name', 'Last name', 'Enter email']) {
    expect(scroll!.contains(field(placeholder)), `"${placeholder}" scrolls with the form`).toBe(true);
  }
  // A tap on a field (or the ticks) while the keyboard is up still lands.
  expect(scroll!.getAttribute('data-persist-taps')).toBe('handled');
}

describe('[ANDROID 9 Nov] sign-up: every field can be reached with the keyboard open', () => {
  it('android, straight from the OTP code: the keyboard is already up, and the form is lifted at once', async () => {
    fx.os = 'android';
    fx.open = KEYBOARD;
    await render();
    expectLiftedForm('android');
  });

  it('android, keyboard opened on the form: the form is lifted when it appears', async () => {
    fx.os = 'android';
    await render();
    fx.open = KEYBOARD;
    await act(async () => { for (const fn of [...(fx.listeners.get('keyboardDidShow') ?? [])]) fn({ endCoordinates: KEYBOARD }); });
    expectLiftedForm('android');
  });

  it('ios: React Native\'s KeyboardAvoidingView, behavior "padding", as before', async () => {
    fx.os = 'ios';
    fx.open = KEYBOARD;
    await render();
    expect(host.querySelector('[data-role="keyboard-avoiding"]')!.getAttribute('data-behavior')).toBe('padding');
    expectLiftedForm('ios');
  });
});
