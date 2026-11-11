/**
 * [MENU-OPTIONS · kitchen-system hook] An order line's choices as a kitchen system reads them, from the order's own
 * snapshot (never today's menu). Nothing calls this yet: a kitchen integration (e.g. the Dragontail adapter, built
 * separately and switched off) maps each row to its catalogue by `optionId` (the menu option it came from, whose
 * kitchen number lives with the option) and places it on the pizza by `side`.
 *
 * `side` follows Dragontail's published POS API (OrderItem.Side): 0 = modifier on the whole pizza, 1 = Half1,
 * 2 = Half2, 3 = a main line. Which physical half is Half1 is an ASSUMPTION (left) to confirm with the store's
 * Dragontail set-up before anything is sent.
 */
export type KitchenPlacement = 'WHOLE' | 'LEFT' | 'RIGHT';

export const KITCHEN_SIDE_FOR_PLACEMENT: Readonly<Record<KitchenPlacement, number>> = { WHOLE: 0, LEFT: 1, RIGHT: 2 };
/** A choice that is not a topping placement (a size, a crust, a follow-up): shown as a modifier of the line. */
export const KITCHEN_SIDE_MODIFIER = 0;

export interface KitchenModifierRow {
  optionId: string | null;
  name: string;
  groupName: string;
  placement: KitchenPlacement | null;
  parentOptionName: string | null;
  setsPrice: boolean;
  side: number;
}

/** The snapshot rows (OrderItemOption) of one line, in order, for a kitchen system. */
export function kitchenModifiers(rows: ReadonlyArray<{
  optionId?: string | null; optionGroupName: string; optionName: string;
  plainGroupName?: string | null; plainOptionName?: string | null; placement?: string | null;
  parentOptionName?: string | null; setsPrice?: boolean | null;
}>): KitchenModifierRow[] {
  return rows.map((r) => {
    const placement = r.placement === 'WHOLE' || r.placement === 'LEFT' || r.placement === 'RIGHT' ? r.placement : null;
    return {
      optionId: r.optionId ?? null,
      name: r.plainOptionName ?? r.optionName,
      groupName: r.plainGroupName ?? r.optionGroupName,
      placement,
      parentOptionName: r.parentOptionName ?? null,
      setsPrice: r.setsPrice === true,
      side: placement ? KITCHEN_SIDE_FOR_PLACEMENT[placement] : KITCHEN_SIDE_MODIFIER,
    };
  });
}
