import React from 'react';
import { Pressable, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { T } from '../../kit';
import { haptic } from '../../lib/haptics';
import { readyTimeLabel } from '../../lib/storeKindWords';
import { PREP_TIME_CHOICES, prepChipLabel, prepChoiceHeading, type PrepChoice } from './prepTime';

/** A tablet-sized target: comfortably above the 48dp floor (kit/touch-target), hit from across a counter. */
export const PREP_CHIP_MIN_HEIGHT = 56;
/** Each choice's share of the row before it grows: all six sit in one row on a tablet, three a row on a phone. */
const PREP_CHIP_BASIS = 80;

/**
 * [APP-PREPTIME · owner 14 Nov 2026] The preparation time beside the app's
 * Accept: the website's six choices (10 to 60 minutes) as large buttons. The
 * chosen one is filled and announced as checked (never colour alone), so a busy
 * kitchen sees the time it is about to promise and accepts in one tap.
 */
export function PrepTimeChips({
  value,
  onChange,
  vendorType,
  disabled,
}: {
  value: number;
  onChange: (minutes: PrepChoice) => void;
  vendorType?: string | null;
  disabled?: boolean;
}) {
  const heading = prepChoiceHeading(vendorType);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={heading} testID="prep-time-chips">
      <T variant="label" weight="semibold" tone="muted">
        {heading}
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
        {PREP_TIME_CHOICES.map((minutes) => {
          const selected = minutes === value;
          return (
            <Pressable
              key={minutes}
              accessibilityRole="radio"
              accessibilityLabel={readyTimeLabel(vendorType, minutes) ?? prepChipLabel(minutes)}
              accessibilityState={{ selected, checked: selected, disabled: !!disabled }}
              disabled={disabled}
              onPress={() => {
                if (selected) return;
                haptic.select();
                onChange(minutes);
              }}
              style={{
                flexGrow: 1,
                flexBasis: PREP_CHIP_BASIS,
                minHeight: PREP_CHIP_MIN_HEIGHT,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: radius.lg,
                borderWidth: 2,
                borderColor: selected ? color.brand[500] : color.border.strong,
                backgroundColor: selected ? color.brand[500] : color.surface.base,
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <T variant="bodyStrong" tone={selected ? 'onBrand' : 'ink'}>
                {prepChipLabel(minutes)}
              </T>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
