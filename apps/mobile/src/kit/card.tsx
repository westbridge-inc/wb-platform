/** @jsxImportSource react */
import React, { useRef } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, elevation, radius, space } from '@swift/ui';
import { T, type TP } from './text';

/**
 * Soft card shadow — separation on paper comes from shadow, not borders.
 *
 * [D1 — decided] This was the THIRD author of the card shadow: the token layer
 * had `shadow.card` (1/3, pure black) and `elevation.card` (6/14, cold black)
 * while every card in the app actually rendered this one (4/12, warm). Now it
 * IS `elevation.card` — imported, not restated — so web and native cannot drift
 * apart again and there is one place to change a card's depth.
 */
export const cardShadow: ViewStyle = elevation.card as ViewStyle;

/** White rounded-16 card. `pad={false}` for image-bleed cards (clips children). */
export function Card({ children, style, pad = true, ...rest }: ViewProps & { pad?: boolean }) {
  return (
    <View
      style={[
        {
          backgroundColor: color.surface.base,
          borderRadius: radius.lg,
          padding: pad ? space.lg : 0,
          overflow: pad ? 'visible' : 'hidden',
        },
        cardShadow,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

/** Semantic heading for popup/dialog titles. Visual typography stays caller-
 *  controlled while VoiceOver/TalkBack gain a reliable heading landmark. */
export function PopupTitle({ variant = 'title', ...rest }: Omit<TP, 'accessibilityRole'>) {
  return <T {...rest} variant={variant} accessibilityRole="header" />;
}

/** Kit centered popup (voucher applied / delivered / logout confirm):
 *  dim scrim, white rounded-20 sheet, caller supplies content + actions.
 *
 *  `onDismissed` fires when the native window is PROVABLY GONE — React
 *  Native's own post-dismissal callback, not a guess. Navigate from there, not
 *  from `onClose`: closing starts the dismissal, it does not finish it, and a
 *  stack transition begun in the same tick lets the modal's window survive
 *  invisibly above the destination screen and eat every touch. That is the
 *  frozen-screen P0, and until now the only thing standing against it was
 *  `InteractionManager.runAfterInteractions` — which React Native 0.85 quietly
 *  replaced with `InteractionManagerStub`, a bare `setImmediate` that waits
 *  for nothing at all. The guard read as if it waited and did not.
 *
 *  iOS only, per React Native: on Android a Modal is not a separate window and
 *  the race does not exist, so callers keep a frame-based fallback.
 *
 *  [BUG-RATING-SHAKE · owner 8 Nov 2026] On Android the card never moves for a
 *  keyboard it did not open. The owner typed a comment on the rating screen,
 *  tapped Submit, and the "Thanks for the feedback!" card bounced up and down
 *  without end. Reproduced on Android with the Cart's promo field and "Clear
 *  your cart?": the keyboard layer below flipped between full height and 96dp
 *  shorter on every frame (60 a second, for as long as the card stayed open),
 *  and the centred card jumped with it; the same card opened with no field
 *  focused drew nothing. The keyboard still belonged to the field on the screen
 *  BELOW: the dialog takes focus, the keyboard is half-withdrawn, and each
 *  resize of the 'height' layer flips what that screen reports (keyboard shown,
 *  hidden), which resizes the layer again. So a card opened while a keyboard is
 *  up does not follow it (nothing of its own is under it), and a card opened
 *  with no keyboard still lifts its own fields (the emergency-contact form, the
 *  step-up and relay codes) above the keyboard they open. The answer is taken
 *  when the card opens and held until it closes, so the layer is never swapped
 *  under a card on screen. */
export function popupFollowsKeyboard(platform: string, keyboardUpWhenOpened: boolean): boolean {
  return platform !== 'android' || !keyboardUpWhenOpened;
}

/** Was a keyboard up when this card opened? Read once per opening, held while it stays open. */
function useKeyboardUpWhenOpened(visible: boolean): boolean {
  const opened = useRef<boolean | null>(null);
  if (!visible) opened.current = null;
  else if (opened.current === null) opened.current = Platform.OS === 'android' && Keyboard.isVisible();
  return opened.current === true;
}

export function PopupCard({
  visible,
  onClose,
  onDismissed,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const followsKeyboard = popupFollowsKeyboard(Platform.OS, useKeyboardUpWhenOpened(visible));

  const backdrop = (
    <Pressable
      onPress={onClose}
      // A labelled Pressable becomes one accessibility element and swallows
      // every heading/button beneath it. Keep the backdrop touchable but out
      // of the accessibility tree; VoiceOver/TalkBack use the modal actions
      // or the escape gesture instead.
      accessible={false}
      focusable={false}
      importantForAccessibility="no"
      style={{
        flex: 1,
        alignItems: 'center',
        backgroundColor: 'rgba(33,26,26,0.45)',
        justifyContent: 'center',
        paddingTop: Math.max(space.lg, insets.top),
        paddingRight: Math.max(space.lg, insets.right),
        paddingBottom: Math.max(space.lg, insets.bottom),
        paddingLeft: Math.max(space.lg, insets.left),
      }}
    >
      <Pressable
        onPress={(e) => e.stopPropagation()}
        accessible={false}
        accessibilityViewIsModal
        focusable={false}
        onAccessibilityEscape={onClose}
        style={[
          {
            width: '100%',
            maxWidth: 560,
            maxHeight: '100%',
            flexShrink: 1,
            backgroundColor: color.surface.base,
            borderRadius: radius.xl,
            overflow: 'hidden',
          },
          cardShadow,
        ]}
      >
        <ScrollView
          bounces={false}
          contentContainerStyle={{
            alignItems: 'center',
            padding: space['2xl'],
          }}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
          style={{ width: '100%', flexShrink: 1 }}
        >
          {children}
        </ScrollView>
      </Pressable>
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} {...(onDismissed ? { onDismiss: onDismissed } : {})}>
      {followsKeyboard ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          {backdrop}
        </KeyboardAvoidingView>
      ) : (
        <View style={{ flex: 1 }}>{backdrop}</View>
      )}
    </Modal>
  );
}
