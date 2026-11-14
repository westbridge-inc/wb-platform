/** @jsxImportSource react */
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { color, space } from '@swift/ui';
import { Chip, PillButton, T } from '../../kit';
import { InlineInput } from './shared';
import { newStockKey, useAdjustStock, useSaveItem, type StockReason } from '../../hooks/vendorops';
import { editablePrice, itemPricePayload } from '../../lib/storeVat';

/**
 * [MENU-ROW-TOOLS · parity audit A5 + A6, owner 14 Nov 2026] The website's row tools on the app's menu list.
 * A5: a manager taps the price, types the new one, saves (the item save the editor sends; before VAT where Swift adds
 * VAT). A6: anyone at the store adjusts a counted item's stock with a reason (the editor's and the website's movement).
 */

/** The server's words for a refusal, or the row's own sentence. */
function refusalWords(error: unknown, fallback: string): string {
  const message = (error as { response?: { data?: { error?: { message?: unknown } } } } | null)?.response?.data?.error?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

/** A5: the price box on one row (opened by tapping the row's price). */
export function RowPriceEdit({ item, onDone }: { item: any; onDone: () => void }) {
  const save = useSaveItem();
  const [price, setPrice] = useState<string>(() => editablePrice(item));
  const [error, setError] = useState<string | null>(null);
  const n = Number(price);
  const valid = price.trim() !== '' && Number.isFinite(n) && n > 0;
  const beforeVat = item.vatListedPrice != null;
  const submit = () => {
    if (!valid || save.isPending) return;
    setError(null);
    save.mutate(
      { id: item.id, data: itemPricePayload(item, n, false) },
      {
        onSuccess: () => onDone(),
        onError: (e: unknown) => setError(refusalWords(e, 'The price didn’t save. Check your connection and try again.')),
      },
    );
  };
  return (
    <View style={{ marginTop: space.md, gap: space.sm }}>
      <T variant="label" weight="semibold">
        {beforeVat ? 'Price before VAT' : 'Price'}
      </T>
      <InlineInput value={price} onChangeText={(v) => { setPrice(v); setError(null); }} keyboardType="decimal-pad" placeholder="0.00" />
      {error ? (
        <T variant="caption" tone="error">
          {error}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <PillButton label="Save price" size="md" style={{ flex: 1 }} loading={save.isPending} disabled={!valid || save.isPending} onPress={submit} />
        <PillButton label="Cancel" variant="soft" size="md" style={{ flex: 1 }} onPress={onDone} />
      </View>
    </View>
  );
}

/** The website's reasons, in its words. */
const REASONS: ReadonlyArray<{ reason: StockReason; label: string }> = [
  { reason: 'RECEIVED', label: 'Received stock' },
  { reason: 'DAMAGED', label: 'Damaged' },
  { reason: 'MANUAL', label: 'Manual correction' },
  { reason: 'RECONCILE', label: 'Count reconcile' },
  { reason: 'RETURN', label: 'Customer return' },
];
/** The server's bound on one movement. */
const MAX_MOVE = 100_000;

/** A6: "Adjust stock" on a counted item's row. */
export function RowStockAdjust({ item }: { item: any }) {
  const adjust = useAdjustStock();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<StockReason>('RECEIVED');
  const [error, setError] = useState<string | null>(null);
  // [MASTER-025] One key per adjustment as entered: Apply again after a failure cannot move stock twice; a changed
  // entry is a new adjustment. Made when the adjuster opens, not for every row drawn.
  const [commandKey, setCommandKey] = useState<string>('');
  const trimmed = delta.trim().replace(/^\+/, '');
  const n = Number(trimmed);
  const valid = /^-?\d+$/.test(trimmed) && n !== 0 && Math.abs(n) <= MAX_MOVE;
  const changed = () => { setCommandKey(newStockKey()); setError(null); };

  if (!open) {
    return (
      <Pressable
        onPress={() => { setCommandKey(newStockKey()); setOpen(true); }}
        accessibilityRole="button"
        accessibilityLabel={`Adjust stock: ${item.name}`}
        style={{ minHeight: space['5xl'], justifyContent: 'center', marginTop: space.sm }}
      >
        <T variant="label" weight="semibold" tone="brand">
          Adjust stock
        </T>
      </Pressable>
    );
  }
  return (
    <View style={{ marginTop: space.md, gap: space.sm }}>
      <T variant="label" weight="semibold">
        Adjust stock
      </T>
      <InlineInput value={delta} onChangeText={(v) => { setDelta(v); changed(); }} placeholder="+24 received, -3 damaged" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {REASONS.map((r) => (
          <Chip key={r.reason} label={r.label} selected={reason === r.reason} onPress={() => { setReason(r.reason); changed(); }} />
        ))}
      </View>
      {error ? (
        <T variant="caption" tone="error" style={{ color: color.error }}>
          {error}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <PillButton
          label="Apply"
          size="md"
          style={{ flex: 1 }}
          loading={adjust.isPending}
          disabled={!valid || adjust.isPending}
          onPress={() => {
            if (!valid || adjust.isPending) return;
            adjust.mutate(
              { itemId: item.id, delta: n, reason, commandKey },
              {
                onSuccess: () => { setOpen(false); setDelta(''); setCommandKey(''); },
                onError: (e: unknown) => setError(refusalWords(e, 'The stock didn’t change. Check your connection and try again.')),
              },
            );
          }}
        />
        <PillButton label="Cancel" variant="soft" size="md" style={{ flex: 1 }} onPress={() => { setOpen(false); setError(null); }} />
      </View>
    </View>
  );
}
