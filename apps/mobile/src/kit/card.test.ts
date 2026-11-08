import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rn = vi.hoisted(() => ({ Platform: { OS: 'ios' }, keyboardUp: false }));

// A plain function call has no renderer behind it: the card's one ref is answered here (a fresh ref per call is
// a fresh opening, which is what each case below is).
vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const hooks = { useRef: (value: unknown) => ({ current: value }) };
  return { ...actual, ...hooks, default: { ...actual['default'], ...hooks } };
});

vi.mock('react-native', () => ({
  Keyboard: { isVisible: () => rn.keyboardUp },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Modal: 'Modal',
  Platform: rn.Platform,
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

vi.mock('@swift/ui', () => ({
  color: { surface: { base: '#fff' } },
  radius: { lg: 16, xl: 20 },
  space: { lg: 16, '2xl': 24 },
  // [D1] `cardShadow` IS `elevation.card` now — the card no longer restates a
  // shadow of its own, so the mock has to carry the token it reads.
  elevation: { card: { boxShadow: '0px 6px 14px rgba(33,26,26,0.08)', elevation: 3 } },
}));

vi.mock('./text', () => ({ T: 'T' }));

import { PopupCard, PopupTitle, popupFollowsKeyboard } from './card';

type TestElement = React.ReactElement<Record<string, unknown>, string>;

function onlyElement(value: unknown, expectedType: string): TestElement {
  expect(React.isValidElement(value)).toBe(true);
  const element = value as TestElement;
  expect(element.type).toBe(expectedType);
  return element;
}

describe('PopupCard', () => {
  beforeEach(() => {
    rn.Platform.OS = 'ios';
    rn.keyboardUp = false;
  });

  it('preserves backdrop dismissal without hiding or activating modal controls', () => {
    const onClose = vi.fn();
    const child = React.createElement('Child', { accessibilityRole: 'button' });
    const modal = onlyElement(PopupCard({ visible: true, onClose, children: child }), 'Modal');
    const keyboardLayer = onlyElement(modal.props['children'], 'KeyboardAvoidingView');
    const backdrop = onlyElement(keyboardLayer.props['children'], 'Pressable');
    const sheet = onlyElement(backdrop.props['children'], 'Pressable');

    expect(modal.props).toMatchObject({
      visible: true,
      transparent: true,
      animationType: 'fade',
      onRequestClose: onClose,
    });
    expect(backdrop.props).toMatchObject({
      accessible: false,
      focusable: false,
      importantForAccessibility: 'no',
      onPress: onClose,
    });
    expect(backdrop.props['style']).toEqual(
      expect.objectContaining({
        paddingTop: 47,
        paddingRight: 16,
        paddingBottom: 34,
        paddingLeft: 16,
      }),
    );
    expect(sheet.props).toMatchObject({
      accessible: false,
      focusable: false,
      accessibilityViewIsModal: true,
      onAccessibilityEscape: onClose,
    });

    (modal.props['onRequestClose'] as () => void)();
    (backdrop.props['onPress'] as () => void)();
    (sheet.props['onAccessibilityEscape'] as () => void)();
    expect(onClose).toHaveBeenCalledTimes(3);

    const stopPropagation = vi.fn();
    (sheet.props['onPress'] as (event: { stopPropagation: () => void }) => void)({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('bounds and scrolls dialog content for small screens, large text, and keyboards', () => {
    const child = React.createElement('Child');
    const modal = onlyElement(
      PopupCard({ visible: true, onClose: vi.fn(), children: child }),
      'Modal',
    );
    const keyboardLayer = onlyElement(modal.props['children'], 'KeyboardAvoidingView');
    const backdrop = onlyElement(keyboardLayer.props['children'], 'Pressable');
    const sheet = onlyElement(backdrop.props['children'], 'Pressable');
    const scrollView = onlyElement(sheet.props['children'], 'ScrollView');

    expect(keyboardLayer.props).toMatchObject({ behavior: 'padding' });
    expect(keyboardLayer.props['style']).toEqual(expect.objectContaining({ flex: 1 }));
    expect(sheet.props['style']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ width: '100%', maxHeight: '100%', flexShrink: 1 }),
      ]),
    );
    expect(scrollView.props).toMatchObject({
      bounces: false,
      keyboardDismissMode: 'on-drag',
      keyboardShouldPersistTaps: 'handled',
      showsVerticalScrollIndicator: true,
    });
    expect(scrollView.props['style']).toEqual(
      expect.objectContaining({ width: '100%', flexShrink: 1 }),
    );
    expect(scrollView.props['contentContainerStyle']).toEqual(
      expect.objectContaining({ alignItems: 'center', padding: 24 }),
    );
    expect(scrollView.props['children']).toBe(child);
  });

  it('gives its shared title an explicit screen-reader heading role', () => {
    const title = PopupTitle({ variant: 'heading', center: true, children: 'Order placed' });
    const element = onlyElement(title, 'T');

    expect(element.props).toMatchObject({
      accessibilityRole: 'header',
      variant: 'heading',
      center: true,
      children: 'Order placed',
    });
  });
});

describe('[BUG-RATING-SHAKE] the card follows only a keyboard it opened (Android)', () => {
  beforeEach(() => {
    rn.Platform.OS = 'android';
    rn.keyboardUp = false;
  });

  const layer = () => {
    const modal = onlyElement(PopupCard({ visible: true, onClose: vi.fn(), children: null }), 'Modal');
    return modal.props['children'] as TestElement;
  };

  it('opened over a keyboard (a field on the screen below): a plain full-height layer, no keyboard avoidance', () => {
    rn.keyboardUp = true;
    const plain = onlyElement(layer(), 'View');
    expect(plain.props['style']).toEqual({ flex: 1 });
    // The same backdrop and card are inside, so taps outside and Android back still close it.
    const backdrop = onlyElement(plain.props['children'], 'Pressable');
    expect(backdrop.props['style']).toEqual(expect.objectContaining({ flex: 1, justifyContent: 'center' }));
  });

  it('opened with no keyboard: it still lifts its own fields above the keyboard they open', () => {
    const keyboardLayer = onlyElement(layer(), 'KeyboardAvoidingView');
    expect(keyboardLayer.props).toMatchObject({ behavior: 'height', style: { flex: 1 } });
  });

  it('iOS is unchanged: always padding, whatever was up when it opened', () => {
    rn.Platform.OS = 'ios';
    rn.keyboardUp = true;
    expect(onlyElement(layer(), 'KeyboardAvoidingView').props).toMatchObject({ behavior: 'padding' });
  });

  it('the rule itself', () => {
    expect(popupFollowsKeyboard('android', true)).toBe(false);
    expect(popupFollowsKeyboard('android', false)).toBe(true);
    expect(popupFollowsKeyboard('ios', true)).toBe(true);
    expect(popupFollowsKeyboard('ios', false)).toBe(true);
  });
});
