/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
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
 *  [BUG-RATING-SHAKE · owner 8 Nov 2026] On Android a card never opens over a
 *  keyboard that belongs to the screen below. The owner typed a comment on the
 *  rating screen, tapped Submit, and the "Thanks for the feedback!" card bounced
 *  up and down without end ("Clear your cart?" over the focused promo field did
 *  the same: 602 frames in 10 s with no input; the same card opened with no
 *  field focused drew none). The dialog took focus with that keyboard half
 *  withdrawn, and each resize of the card's 'height' keyboard layer flipped what
 *  the screen below reported (keyboard shown / hidden), which resized the layer
 *  again. So that keyboard is put away first: the card waits, closed, until it
 *  has gone (or KEYBOARD_GONE_MS at most), then opens. Its content mounts only
 *  then, so a field of its own (a step-up or relay code, a reference, the
 *  emergency-contact form) still takes focus and is lifted above the keyboard IT
 *  opens. iOS is unchanged; a hardware keyboard shows no keyboard and is never
 *  waited for. */
export const KEYBOARD_GONE_MS = 300;

/** Android: true while a card asked to open waits for another screen's keyboard to go. */
function useWaitForForeignKeyboard(visible: boolean): boolean {
  const [asked, setAsked] = useState(false);
  const [waiting, setWaiting] = useState(false);
  // Decided in the render where `visible` turns true, before anything of the card mounts.
  if (visible !== asked) {
    setAsked(visible);
    setWaiting(visible && Platform.OS === 'android' && Keyboard.isVisible());
  }
  useEffect(() => {
    if (!waiting) return undefined;
    let settled = false;
    const open = () => {
      if (settled) return;
      settled = true;
      setWaiting(false);
    };
    // Nothing of the card is mounted yet: this blurs only the field on the screen below.
    Keyboard.dismiss();
    const gone = Keyboard.addListener('keyboardDidHide', open);
    const fallback = setTimeout(open, KEYBOARD_GONE_MS);
    return () => {
      settled = true;
      gone.remove();
      clearTimeout(fallback);
    };
  }, [waiting]);
  return waiting;
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
  const waiting = useWaitForForeignKeyboard(visible);

  return (
    <Modal visible={visible && !waiting} transparent animationType="fade" onRequestClose={onClose} {...(onDismissed ? { onDismiss: onDismissed } : {})}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
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
      </KeyboardAvoidingView>
    </Modal>
  );
}
