import { useState } from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { Chip, PillButton, T } from '../../kit';
import { InlineInput } from './shared';
import { halfRuleWords, parseHalfPercent, type GroupFlags } from '../../lib/menuOptionsEditor';

/** [MENU-OPTIONS · owner 11 Nov 2026] A new group's rules before the store picks any. */
export const NEW_GROUP_FLAGS: GroupFlags = { required: false, multi: false, setsPrice: false, allowHalves: false, halfPercent: 100 };

/** [MENU-OPTIONS] A chip row for a group's size / half-and-half rule (the new-group form and each saved group). */
export function GroupRuleChips({ flags, onChange, sizeTaken, disabled, live = false }: {
  flags: GroupFlags;
  onChange: (_next: Partial<GroupFlags>) => void;
  /** Another group of the item already sets the price (an item has only one). */
  sizeTaken: boolean;
  disabled?: boolean;
  /** [REVIEW-MENU-B S3-2] A saved group (each change is saved at once): "% of the choice price" only opens the percent
   *  box, and Set saves the percent the store typed (never a 50% nobody chose). A form (new group, library editor)
   *  keeps its choices until its own save. */
  live?: boolean;
}) {
  const [pctText, setPctText] = useState(flags.halfPercent === 100 ? '50' : String(flags.halfPercent));
  const pct = parseHalfPercent(pctText);
  const [pctOpen, setPctOpen] = useState(flags.halfPercent !== 100);
  const percentMode = live ? pctOpen || flags.halfPercent !== 100 : flags.halfPercent !== 100;
  const fullPrice = () => { setPctOpen(false); if (!live || flags.halfPercent !== 100) onChange({ halfPercent: 100 }); };
  const percentOf = () => { setPctOpen(true); if (!live) onChange({ halfPercent: pct ?? 50 }); };
  return (
    <View style={{ marginTop: space.sm, gap: space.sm }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {!sizeTaken || flags.setsPrice ? (
          <Chip label="Sets the price" selected={flags.setsPrice} onPress={disabled ? undefined : () => onChange({ setsPrice: !flags.setsPrice, ...(!flags.setsPrice ? { allowHalves: false } : {}) })} style={{ height: 34, paddingHorizontal: space.md }} />
        ) : null}
        {!flags.setsPrice ? (
          <Chip label="Half-and-half" selected={flags.allowHalves} onPress={disabled ? undefined : () => onChange({ allowHalves: !flags.allowHalves })} style={{ height: 34, paddingHorizontal: space.md }} />
        ) : null}
      </View>
      {flags.setsPrice ? (
        <T variant="caption" tone="muted">Customers pick exactly one. Each choice’s price is the item’s price (like Small / Large).</T>
      ) : null}
      {flags.allowHalves && !flags.setsPrice ? (
        <View style={{ gap: space.sm }}>
          <T variant="caption" weight="semibold" tone="muted">A half costs</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <Chip label="Full price" selected={!percentMode} onPress={disabled ? undefined : fullPrice} style={{ height: 34, paddingHorizontal: space.md }} />
            <Chip label="% of the choice price" selected={percentMode} onPress={disabled ? undefined : percentOf} style={{ height: 34, paddingHorizontal: space.md }} />
          </View>
          {percentMode ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <InlineInput style={{ width: 96 }} value={pctText} onChangeText={setPctText} placeholder="Half costs (%)" keyboardType="number-pad" />
              <PillButton label="Set" size="sm" variant="soft" disabled={disabled || pct == null || pct === flags.halfPercent} onPress={() => { if (pct != null) onChange({ halfPercent: pct }); }} />
              <T variant="caption" tone="muted" style={{ flex: 1 }}>{halfRuleWords(flags.halfPercent)}</T>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
