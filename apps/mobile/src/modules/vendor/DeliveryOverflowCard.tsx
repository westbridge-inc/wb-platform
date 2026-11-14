import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { color, space } from '@swift/ui';
import { Card, Chip, LabeledInput, PillButton, T } from '../../kit';
import { useKitchenOverflow, useSetKitchenOverflow } from '../../hooks/vendorops';
import {
  DAY_NAMES,
  NEW_BUSY_WINDOW,
  OVERFLOW_MODE_OPTIONS,
  OVERFLOW_NOTE,
  OVERFLOW_TITLE,
  busyWindowProblem,
  usesBusyHours,
  type BusyWindow,
  type OverflowMode,
  type OverflowSetting,
} from './deliveryOverflow';

/**
 * [DT-OVERFLOW · owner 14 Nov 2026] "Swift riders when you're busy" — a branch connected to Dragontail chooses when
 * its cash deliveries go to Swift riders instead of its own drivers. Shown only to an owner or manager, and only when
 * the server says the setting applies to this branch (`available`): every other store sees nothing.
 */
export function DeliveryOverflowCard({ enabled }: { enabled: boolean }) {
  const read = useKitchenOverflow(enabled);
  const save = useSetKitchenOverflow();
  const setting = read.data as OverflowSetting | undefined;
  const [mode, setMode] = useState<OverflowMode>('NONE');
  const [windows, setWindows] = useState<BusyWindow[]>([]);
  useEffect(() => {
    if (!setting) return;
    setMode(setting.mode);
    setWindows(setting.busyHours ?? []);
  }, [setting]);
  if (!enabled || !setting?.available) return null;

  const hours = usesBusyHours(mode);
  const problems = hours ? windows.map(busyWindowProblem) : [];
  const blocked = problems.some(Boolean) || (hours && windows.length === 0);
  const update = (i: number, patch: Partial<BusyWindow>) => setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  return (
    <Card style={{ marginBottom: space.lg }} testID="delivery-overflow-card">
      <T variant="body" weight="bold">{OVERFLOW_TITLE}</T>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>{OVERFLOW_NOTE}</T>
      <View style={{ marginTop: space.md, gap: space.sm }}>
        {OVERFLOW_MODE_OPTIONS.map((option) => (
          <Pressable
            key={option.mode}
            onPress={() => setMode(option.mode)}
            accessibilityRole="radio"
            accessibilityState={{ checked: mode === option.mode }}
            accessibilityLabel={option.label}
            testID={`overflow-mode-${option.mode}`}
            style={{ borderWidth: 1, borderRadius: 12, padding: space.md, borderColor: mode === option.mode ? color.brand[500] : color.border.strong }}
          >
            <T variant="label" weight="semibold">{option.label}</T>
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>{option.detail}</T>
          </Pressable>
        ))}
      </View>
      {hours ? (
        <View style={{ marginTop: space.md, gap: space.md }}>
          <T variant="label" weight="semibold">Busy hours (Guyana time)</T>
          {windows.map((w, i) => (
            <View key={i} style={{ gap: space.sm }} testID={`busy-window-${i}`}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                {DAY_NAMES.map((name, day) => (
                  <Chip key={name} label={name.slice(0, 3)} selected={w.day === day} onPress={() => update(i, { day })} />
                ))}
              </View>
              <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
                <LabeledInput label="From" value={w.start} onChangeText={(start) => update(i, { start })} placeholder="18:00" containerStyle={{ flex: 1 }} autoCapitalize="none" />
                <LabeledInput label="To" value={w.end} onChangeText={(end) => update(i, { end })} placeholder="21:00" containerStyle={{ flex: 1 }} autoCapitalize="none" />
                <PillButton label="Remove" variant="outline" size="md" onPress={() => setWindows((ws) => ws.filter((_, j) => j !== i))} />
              </View>
              {problems[i] ? <T variant="caption" tone="error">{problems[i]}</T> : null}
            </View>
          ))}
          {windows.length < 28 ? (
            <PillButton label="Add busy hours" variant="outline" size="md" onPress={() => setWindows((ws) => [...ws, { ...NEW_BUSY_WINDOW }])} testID="add-busy-window" />
          ) : null}
          <T variant="caption" tone="muted">A window that ends before it starts runs past midnight (e.g. Friday 22:00 to 02:00).</T>
        </View>
      ) : null}
      <PillButton
        label="Save"
        size="md"
        style={{ marginTop: space.md }}
        disabled={save.isPending || blocked}
        loading={save.isPending}
        onPress={() => save.mutate({ mode, ...(hours ? { busyHours: windows } : {}) })}
        testID="save-delivery-overflow"
      />
      {save.isError ? (
        <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
          {(save.error as any)?.response?.data?.error?.message ?? 'Couldn’t save — try again.'}
        </T>
      ) : null}
    </Card>
  );
}
