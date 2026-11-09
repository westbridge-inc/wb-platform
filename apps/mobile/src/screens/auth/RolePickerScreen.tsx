/** @jsxImportSource react */
import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useAuthStore } from '../../stores/authStore';
import { useMoverPreview } from '../../stores/moverPreview';
import { useVendorPreview } from '../../stores/vendorPreview';
import { DEFAULT_COUNTRY } from '../../lib/markets';
import { SwiftMark } from '../../components/SwiftLogo';
import { Pictogram, Screen, T, type PictogramName } from '../../kit';
import { PressableScale } from '../../kit/pressable-scale';
import { haptic } from '../../lib/haptics';
import { useAdsEnabled } from '../../hooks/useAdsEnabled';

// FIRST OPEN [first-open spec 2.1]: one screen, the DOORS, zero carousel. This
// screen exists ONLY for people the server doesn't know yet; "Already have an
// account? Sign in" routes by the account and skips the question forever (SO-4).
//
// [APP-INTRO · owner 8 Nov 2026] The brand intro (components/LaunchIntro)
// dissolves into this screen, and the screen now opens the same FOUR doors as
// swiftgy.com's front page (apps/web/src/app/(welcome)/page.tsx), in the
// website's own words and order: Order with Swift, Sell on Swift, Deliver with
// Swift, Drive with Swift. Each door is the role choice the app already had —
// nothing here is a new sign-up path:
//   Order   → intent 'customer' → Home, browsing as a guest (sign-in at checkout)
//   Sell    → intent 'vendor'   → phone sign-up "as a business", then the business setup
//   Deliver → intent 'mover', moverPreset 'delivery' → phone sign-up, then the
//             driver application with a motorbike preselected
//   Drive   → intent 'mover', moverPreset 'taxi' → the same, with a car preselected
// (MoverOnboardingScreen reads moverPreset; the vehicle can still be changed.)
//
// Rendered from local state only: nothing on this screen waits for the
// network. The one read under it is the advertising switch, which only adds a
// row at the very bottom when ads are on.
//
// ONE BRAND MOMENT. The entry surface gets one accent, not four: giving each
// door its own hue made the door vibrate and made "choose a Swift" read as
// "choose a colour". "Order with Swift" — the app most people are here for —
// alone wears the brand fill; the three partner doors sit under their own
// small heading on the same quiet ground with ink pictograms.
type Door = {
  key: 'customer' | 'vendor' | 'delivery' | 'taxi';
  intent: 'customer' | 'mover' | 'vendor';
  moverPreset: 'delivery' | 'taxi' | null;
  pictogram: PictogramName;
  title: string;
  sub: string;
  hint: string;
};

const ORDER: Door = {
  key: 'customer',
  intent: 'customer',
  moverPreset: null,
  pictogram: 'groceries',
  title: 'Order with Swift',
  sub: 'Browse every store, menu and price, then order food, groceries and more.',
  hint: 'Continue to customer browsing',
};

const PARTNER_DOORS: Door[] = [
  {
    key: 'vendor',
    intent: 'vendor',
    moverPreset: null,
    pictogram: 'shops',
    title: 'Sell on Swift',
    sub: 'One flat weekly fee. You keep every dollar you sell.',
    hint: 'Start business sign-up',
  },
  {
    key: 'delivery',
    intent: 'mover',
    moverPreset: 'delivery',
    pictogram: 'send',
    title: 'Deliver with Swift',
    sub: 'Every delivery fee and every tip is yours.',
    hint: 'Start delivery rider sign-up',
  },
  {
    key: 'taxi',
    intent: 'mover',
    moverPreset: 'taxi',
    pictogram: 'taxi',
    title: 'Drive with Swift',
    sub: 'Drive a taxi with Swift. Every fare and every tip is yours.',
    hint: 'Start taxi driver sign-up',
  },
];

/** The four doors, in the website's order. Exported for the navigation tests. */
export const WELCOME_DOORS: readonly Door[] = [ORDER, ...PARTNER_DOORS];

/** On a tablet the doors keep a phone's reading width instead of stretching edge to edge. */
const CONTENT_MAX_WIDTH = 560;

/** A funnel row in the "just looking" list: glyph, label, chevron. Open paper,
 *  hairline divider — the card chassis it used to sit in is gone, and so is the
 *  filled brand circle around the glyph. Maroon is reserved for the flagship
 *  and the primary action; a preview link is neither. */
function QuietRow({
  icon,
  label,
  hint,
  testID,
  first = false,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  hint: string;
  testID: string;
  first?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={{
        // 44 is the floor, not the look: the row sits at 56 for the list's
        // rhythm and never below the touch-target minimum.
        minHeight: 44,
        height: 56,
        maxWidth: '100%',
        justifyContent: 'center',
        borderTopWidth: first ? 0 : 1,
        borderTopColor: color.border.subtle,
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      {({ pressed }) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, opacity: pressed ? 0.6 : 1 }}>
          <Feather name={icon} size={18} color={color.text.primary} />
          <T variant="label" weight="semibold" style={{ flex: 1, flexShrink: 1 }}>
            {label}
          </T>
          <Feather name="chevron-right" size={17} color={color.text.muted} />
        </View>
      )}
    </Pressable>
  );
}

export function RolePickerScreen() {
  const adsEnabled = useAdsEnabled();
  const insets = useSafeAreaInsets();
  const setIntent = useAuthStore((s) => s.setIntent);
  const setMoverPreset = useAuthStore((s) => s.setMoverPreset);
  const setCountry = useAuthStore((s) => s.setCountry);
  const promptLogin = useAuthStore((s) => s.promptLogin);
  const enterPreview = useMoverPreview((s) => s.enterPreview);
  const enterVendorPreview = useVendorPreview((s) => s.enterPreview);

  const pick = (door: Door) => {
    haptic.select();
    // Deliver and Drive preselect the vehicle in the driver application (a
    // motorbike or a car); every other door clears a stale one.
    setMoverPreset(door.moverPreset);
    // V1 is Guyana-only. Seed the released market synchronously so no entry
    // path flashes or blocks on a country-selection screen.
    setCountry(DEFAULT_COUNTRY);
    setIntent(door.intent);
  };

  // One door: pictogram tile, the website's title and line, a chevron. The
  // flagship's tile alone is maroon. Spaced so all four doors AND "Sign in"
  // sit above the fold on an iPhone SE (667 pt); anything shorter scrolls.
  const door = (d: Door, flagship: boolean) => (
    <PressableScale
      testID={`role-picker-${d.key}`}
      onPress={() => pick(d)}
      accessibilityRole="button"
      accessibilityLabel={`${d.title}. ${d.sub}`}
      accessibilityHint={d.hint}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.lg,
        minHeight: 44,
        paddingVertical: space.md,
      }}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: radius.lg,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: flagship ? color.brand[500] : color.surface.sunken,
        }}
      >
        <Pictogram name={d.pictogram} size={28} color={flagship ? color.white : color.text.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <T variant="heading">{d.title}</T>
        <T variant="caption" tone="muted" style={{ marginTop: space.xs / 2 }}>
          {d.sub}
        </T>
      </View>
      <Feather name="chevron-right" size={20} color={color.text.muted} />
    </PressableScale>
  );

  return (
    <Screen bleed testID="role-picker-screen">
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingBottom: space['2xl'] + insets.bottom,
          width: '100%',
          maxWidth: CONTENT_MAX_WIDTH,
          alignSelf: 'center',
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* THE CHROME IS PAPER, NOT BRAND. This screen used to open on a
            full-bleed maroon slab with a reversed mark and white copy. There is
            no such slab anywhere in the design: the top of a screen is the same
            warm paper as the rest of it. So the door is now the mark in its own
            colours, one INK display-face line, and a muted sub-line (in the
            website's words) — the same shape Home's header took when it stopped
            reaching for the masthead. The maroon moment is the launch intro that
            dissolves into this screen.
            `GradientMasthead` is NOT deleted and is still exported from the kit (FG-2), but this screen was the last caller: it now has ZERO call sites app-wide and is dead code awaiting a founder decision. Logged as an FG-2 deletion candidate — not removed here. */}
        <View
          style={{
            paddingTop: insets.top + space['2xl'],
            paddingHorizontal: space['2xl'],
            paddingBottom: space.md,
          }}
        >
          <SwiftMark size={44} />
          <T variant="display" style={{ marginTop: space.md }}>
            Welcome to Swift
          </T>
          <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
            One app for {DEFAULT_COUNTRY.name}. The people doing the work keep 100% of what they earn.
          </T>
        </View>

        <View style={{ paddingHorizontal: space['2xl'] }}>
          {/* THE DOORS, on open paper. Four maroon cards read as four adverts
              for the same brand; hairline-separated rows read as doors. Nothing
              here is wrapped in a card — a card chassis is earned only by a
              live interruption with a countdown, and a question is not that. */}
          <View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: color.border.subtle }}>
            {door(ORDER, true)}
          </View>

          <T
            variant="micro"
            tone="muted"
            weight="semibold"
            accessibilityRole="header"
            style={{ marginTop: space.lg, marginBottom: space.xs, letterSpacing: 0.8 }}
          >
            EARN WITH SWIFT
          </T>
          <View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: color.border.subtle }}>
            {PARTNER_DOORS.map((d, i) => (
              <View key={d.key} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: color.border.subtle }}>
                {door(d, false)}
              </View>
            ))}
          </View>

          {/* The account answers: sign in first and the door question is never
              asked — the server's roles + last-used role route (SO-4). The
              action reads in INK, not maroon: the flagship already spent this
              screen's one brand moment, and a second one would make the two
              compete at the door. */}
          <Pressable
            testID="role-picker-sign-in"
            onPress={() => {
              haptic.select();
              setCountry(DEFAULT_COUNTRY);
              setIntent(null);
              promptLogin();
            }}
            style={{
              minHeight: 44,
              maxWidth: '100%',
              paddingHorizontal: space.sm,
              marginTop: space.lg,
              alignSelf: 'center',
              justifyContent: 'center',
            }}
            accessibilityRole="button"
            accessibilityLabel="Already have an account? Sign in"
            accessibilityHint="Open phone sign in"
          >
            {({ pressed }) => (
              <T
                variant="label"
                tone="muted"
                style={{ flexShrink: 1, textAlign: 'center', opacity: pressed ? 0.6 : 1 }}
              >
                Already have an account?{' '}
                <T variant="label" weight="semibold">
                  Sign in
                </T>
              </T>
            )}
          </Pressable>

          {/* Growth funnel: real dashboards with sample data (R3/R4) and the
              advertiser surface. They were three unlabelled links floating in
              the dead space under the fold, reading like debug shortcuts; a
              titled, hairline-ruled list keeps them quiet AND deliberate.
              Never co-equal with the doors. */}
          <T
            variant="micro"
            tone="muted"
            weight="semibold"
            style={{ marginTop: space['3xl'], marginBottom: space.sm, letterSpacing: 0.8 }}
          >
            JUST LOOKING?
          </T>
          <View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: color.border.subtle }}>
            <QuietRow
              first
              icon="eye"
              label="Preview the driver app"
              hint="Open a read-only sample driver dashboard"
              testID="role-picker-preview-driver"
              onPress={() => {
                setCountry(DEFAULT_COUNTRY);
                setMoverPreset('taxi');
                enterPreview('DRIVER');
                setIntent('mover');
              }}
            />
            <QuietRow
              icon="eye"
              label="Preview a business dashboard"
              hint="Open a read-only sample business dashboard"
              testID="role-picker-preview-business"
              onPress={() => {
                setCountry(DEFAULT_COUNTRY);
                enterVendorPreview('RESTAURANT');
                setIntent('vendor');
              }}
            />
            {adsEnabled && <QuietRow
              icon="tv"
              label="Advertise on Swift"
              hint="Open Swift advertising"
              testID="role-picker-advertiser"
              onPress={() => {
                setCountry(DEFAULT_COUNTRY);
                setIntent('advertiser');
              }}
            />}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
