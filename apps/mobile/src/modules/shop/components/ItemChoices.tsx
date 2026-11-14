/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { CheckRow, Chip, Segmented, T, TonePill } from '../../../kit';
import { money } from '../../../lib/money';
import { halfPrice } from '../../../lib/menuOptionsEngine';
import {
  followUpFor,
  groupGuidance,
  isChosen,
  onSale,
  placementOf,
  requiredGroup,
  singleChoice,
  sortedOptions,
  topLevelGroups,
  type Placement,
  type SheetGroup,
  type SheetOption,
  type SheetSelection,
} from '../../../lib/menuSheet';

/**
 * [MENU-OPTIONS · owner 11 Nov 2026] An item's choices on the phone, like a pizza shop's sheet: each group with
 * "Required" and "Choose 1" / "Choose up to 3"; a round box for a pick-one group, a square one for pick-many; a
 * size shows its PRICE (it is the item's price), any other choice what it adds; a half-and-half topping, once on,
 * goes on the Whole pizza, the Left half or the Right half (with the half's price); a choice that opens a follow-up
 * group shows that group right under it while it is chosen. A sold-out choice is shown, never chosen.
 *
 * Every decision is lib/menuSheet's (what a tap does) and the server's pricing rules (lib/menuOptionsEngine): this
 * only draws them. Plain function of its props (no hooks), so it can be drawn and read in a test.
 */
export interface ItemChoicesProps {
  groups: SheetGroup[];
  selection: SheetSelection;
  onChoose: (groupId: string, optionId: string) => void;
  onPlace: (groupId: string, optionId: string, placement: Placement) => void;
}

const PLACEMENTS: ReadonlyArray<{ key: Placement; label: string }> = [
  { key: 'WHOLE', label: 'Whole' },
  { key: 'LEFT', label: 'Left half' },
  { key: 'RIGHT', label: 'Right half' },
];

/** What a choice's row says about money: a size its price, any other choice what it adds (nothing when free). */
export function choicePriceWords(group: SheetGroup, option: SheetOption): string {
  const price = Number(option.additionalPrice);
  if (!Number.isFinite(price)) return '';
  if (group.setsPrice === true) return money(price);
  return price > 0 ? `+${money(price)}` : '';
}

/** Under a chosen half-and-half topping: what the whole and a half cost (nothing when it is free). */
export function halfPriceWords(group: SheetGroup, option: SheetOption): string | null {
  const price = Number(option.additionalPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const half = halfPrice(price, group.halfPricePercent ?? 100);
  return `Whole +${money(price)} · half +${money(half)}`;
}

function optionLabel(group: SheetGroup, option: SheetOption): string {
  const price = choicePriceWords(group, option);
  return price ? `${option.name} · ${price}` : option.name;
}

export function ItemChoices({ groups, selection, onChoose, onPlace }: ItemChoicesProps) {
  const drawn = new Set<string>();

  const drawGroup = (group: SheetGroup, nested: boolean): React.ReactElement => {
    drawn.add(group.id);
    const required = requiredGroup(group);
    const options = sortedOptions(group);
    const anyOnSale = options.some(onSale);
    return (
      <View
        key={group.id}
        testID={`menu-group-${group.id}`}
        style={nested ? { marginTop: space.sm, marginLeft: space.xl, gap: space.xs } : { marginTop: space['2xl'], gap: space.xs }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <T variant={nested ? 'label' : 'heading'} weight={nested ? 'semibold' : undefined} style={{ flex: 1 }}>
            {group.name}
          </T>
          {required ? <TonePill label="Required" tone="warning" /> : <T variant="caption" tone="faint">Optional</T>}
        </View>
        <T variant="caption" tone="muted">
          {groupGuidance(group)}
        </T>
        {anyOnSale ? null : (
          <T variant="caption" tone="warning">
            Every choice here is sold out right now.
          </T>
        )}
        {options.map((option) => {
          if (!onSale(option)) {
            // [F4] Shown so the menu stays honest, never chosen (the server refuses it anyway).
            return (
              <View key={option.id} style={{ flexDirection: 'row', paddingVertical: space.xs }}>
                <Chip label={`${option.name} · sold out`} style={{ height: 42, paddingHorizontal: space.lg, opacity: 0.45 }} />
              </View>
            );
          }
          const chosen = isChosen(selection, group.id, option.id);
          const placement = chosen && group.allowHalves === true ? placementOf(selection, group.id, option.id) : null;
          const followUp = chosen && !nested ? followUpFor(groups, group, option) : null;
          const halfWords = placement ? halfPriceWords(group, option) : null;
          return (
            <View key={option.id}>
              <CheckRow
                kind={singleChoice(group) ? 'radio' : 'checkbox'}
                checked={chosen}
                label={optionLabel(group, option)}
                onToggle={() => onChoose(group.id, option.id)}
                testID={`menu-option-${option.id}`}
              />
              {placement ? (
                <View style={{ marginLeft: space['3xl'], marginBottom: space.sm, gap: space.xs }}>
                  <Segmented options={PLACEMENTS} value={placement} onChange={(next) => onPlace(group.id, option.id, next)} />
                  {halfWords ? (
                    <T variant="caption" tone="faint">
                      {halfWords}
                    </T>
                  ) : null}
                </View>
              ) : null}
              {followUp && !drawn.has(followUp.id) ? drawGroup(followUp, true) : null}
            </View>
          );
        })}
      </View>
    );
  };

  return <>{topLevelGroups(groups).map((group) => drawGroup(group, false))}</>;
}
