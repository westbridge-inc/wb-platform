/** @jsxImportSource react */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  View,
  type KeyboardMetrics,
  type LayoutChangeEvent,
  type LayoutRectangle,
  type ViewProps,
} from 'react-native';

/**
 * KeyboardAvoider — the view a form screen wraps its scroll area in, so the
 * open keyboard never covers a field the shopper cannot then scroll to.
 *
 * [ANDROID 9 Nov] Sign-up on Android: with the keyboard open the form would
 * not scroll down to the email field. Expo SDK 56 / RN 0.85 draw every Android
 * window EDGE-TO-EDGE (mandatory — Expo's prebuild refuses to turn it off), and
 * an edge-to-edge window is never resized for the keyboard: `adjustResize`
 * (app.config softwareKeyboardLayoutMode, default 'resize') is inert, RN does
 * not apply the IME inset, and safe-area insets exclude the keyboard. The
 * screens said `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` —
 * "Android resizes by itself" — and RN's KeyboardAvoidingView with no behavior
 * is a plain View that never moves.
 *
 * So this pads itself by however much of it the keyboard covers, on BOTH
 * platforms (0 if a device ever does resize the window):
 * - iOS: React Native's own KeyboardAvoidingView, behavior 'padding' — what
 *   these screens already used there, unchanged.
 * - Android: the same padding sum (RN KeyboardAvoidingView `_relativeKeyboardHeight`:
 *   frame.y + frame.height - keyboard.screenY), plus the one thing RN's view
 *   cannot do on Android: start from a keyboard that is ALREADY up. Android
 *   sends keyboardDidShow only when the keyboard appears, never when focus moves
 *   between fields, and RN's view starts at 0 when it mounts under an open
 *   keyboard. That is exactly the sign-up path: the OTP code's keyboard stays
 *   open while focus jumps to First Name on the next screen. `Keyboard.metrics()`
 *   is the open keyboard's last reported frame.
 *
 * Like RN's view, the frame is measured relative to the parent: mount it as a
 * direct child of the full-height Screen.
 */
export function KeyboardAvoider(props: ViewProps) {
  return Platform.OS === 'ios' ? <KeyboardAvoidingView behavior="padding" {...props} /> : <AndroidKeyboardAvoider {...props} />;
}

/** The part of a view the keyboard covers, in the view's parent's coordinates. */
export function keyboardOverlap(frame: Pick<LayoutRectangle, 'y' | 'height'> | null, keyboard: Pick<KeyboardMetrics, 'screenY'> | null): number {
  if (!frame || !keyboard) return 0;
  return Math.max(frame.y + frame.height - keyboard.screenY, 0);
}

function openKeyboard(): KeyboardMetrics | null {
  return Keyboard.isVisible?.() ? (Keyboard.metrics?.() ?? null) : null;
}

function AndroidKeyboardAvoider({ children, style, onLayout, ...rest }: ViewProps) {
  const frame = useRef<LayoutRectangle | null>(null);
  const keyboard = useRef<KeyboardMetrics | null>(openKeyboard());
  const [bottom, setBottom] = useState(0);
  const update = useCallback(() => setBottom(keyboardOverlap(frame.current, keyboard.current)), []);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (e) => {
      keyboard.current = e.endCoordinates;
      update();
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      keyboard.current = null;
      update();
    });
    // A keyboard that came or went between the first render and now.
    keyboard.current = openKeyboard();
    update();
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [update]);

  const measured = useCallback(
    (e: LayoutChangeEvent) => {
      frame.current = e.nativeEvent.layout;
      update();
      onLayout?.(e);
    },
    [onLayout, update],
  );

  return (
    <View {...rest} style={[style, { paddingBottom: bottom }]} onLayout={measured}>
      {children}
    </View>
  );
}
