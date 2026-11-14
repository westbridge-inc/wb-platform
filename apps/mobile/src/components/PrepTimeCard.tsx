/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, Chip, PillButton, T } from '../kit';
import { PREP_TIME_CHOICES, prepChipLabel, usualPrepHeading, usualPrepLine } from '../modules/vendor/prepTime';

/**
 * [STORE-PREP · parity audit C3, owner ruling 14 Nov 2026] The store's usual preparation time: the owner or a manager
 * picks one of Accept's own choices (10-60 min); every new order then starts Accept at it. Staff can still pick
 * another time on each order. The website's Settings card says the same.
 */
export function PrepTimeCard({
  value,
  vendorType,
  saving,
  error,
  onSave,
}: {
  /** The stored usual time (minutes), or null when none is set. */
  value: number | null;
  vendorType?: string | null;
  saving?: boolean;
  error?: string | null;
  onSave: (minutes: number) => void;
}) {
  const [pick, setPick] = useState<number | null>(value);
  useEffect(() => setPick(value), [value]);
  const dirty = pick != null && pick !== value;

  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name="clock" size={18} color={color.brand[600]} />
        <T variant="label" weight="semibold">{usualPrepHeading(vendorType)}</T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        {usualPrepLine(pick)}
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
        {PREP_TIME_CHOICES.map((minutes) => (
          <Chip key={minutes} label={prepChipLabel(minutes)} selected={pick === minutes} onPress={() => setPick(minutes)} style={{ height: 40, minWidth: 64 }} />
        ))}
      </View>
      {error ? (
        <T variant="caption" style={{ marginTop: space.xs, color: color.error }}>
          {error}
        </T>
      ) : null}
      {dirty ? (
        <PillButton label="Save" size="md" loading={saving} disabled={saving} onPress={() => onSave(pick!)} style={{ marginTop: space.md }} />
      ) : null}
    </Card>
  );
}
