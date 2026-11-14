import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@swift/ui', () => ({ space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, '2xl': 24, '3xl': 32 } }));
vi.mock('../../../kit', () => ({ CheckRow: 'CheckRow', Chip: 'Chip', Segmented: 'Segmented', T: 'T', TonePill: 'TonePill' }));
vi.mock('../../../lib/money', () => ({ money: (amount: number) => `$${amount.toLocaleString('en-US')}` }));

import { ItemChoices, choicePriceWords, halfPriceWords } from './ItemChoices';
import { chooseOption, defaultSelection, placeOption, type SheetGroup, type SheetOption, type SheetSelection } from '../../../lib/menuSheet';
import { sheetUnitPrice } from '../../../lib/menuPrice';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] The phone's item sheet, drawn and tapped: "Required" and "Choose 1" / "Choose
// up to 3"; a size shows its price; a topping once on gets Whole / Left half / Right half with the half's price; a
// follow-up group appears right under its opener only while it is chosen; sold out is shown, never tappable.
// Synthetic menu only.
// ---------------------------------------------------------------------------

const opt = (id: string, name: string, additionalPrice: number, extra: Partial<SheetOption> = {}): SheetOption =>
  ({ id, name, additionalPrice, isAvailable: true, isDefault: false, sortOrder: 0, followUpGroupId: null, ...extra });
const group = (id: string, name: string, options: SheetOption[], extra: Partial<SheetGroup> = {}): SheetGroup =>
  ({ id, name, isRequired: false, minSelect: 0, maxSelect: 1, sortOrder: 0, setsPrice: false, allowHalves: false, halfPricePercent: 100, options, ...extra });

const PIZZA = {
  basePrice: 1200,
  optionGroups: [
    group('size', 'Size', [opt('personal', 'Personal', 1200), opt('large', 'Large', 3500, { sortOrder: 1 })], { setsPrice: true, isRequired: true, minSelect: 1 }),
    group('crust', 'Crust', [opt('thin', 'Thin', 0, { isDefault: true }), opt('stuffed', 'Stuffed crust', 500, { followUpGroupId: 'cheese', sortOrder: 1 })],
      { isRequired: true, minSelect: 1, sortOrder: 1 }),
    group('cheese', 'Cheese', [opt('mozz', 'Mozzarella', 0), opt('cheddar', 'Cheddar', 100, { sortOrder: 1 })], { isRequired: true, minSelect: 1, sortOrder: 2 }),
    group('toppings', 'Toppings', [opt('pep', 'Pepperoni', 300), opt('mush', 'Mushroom', 175, { sortOrder: 1, isAvailable: false })],
      { allowHalves: true, halfPricePercent: 50, maxSelect: 3, sortOrder: 3 }),
  ],
};

function nodes(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out; }
  out.push(node);
  nodes(node.props?.children, out);
  return out;
}
const texts = (tree: any[]) => tree.filter((n) => n.type === 'T' || n.type === 'TonePill').map((n) => n.props.label ?? [n.props.children].flat().join(''));

/** Draws the sheet; each tap goes through the same model the screen uses, and the sheet is drawn again. */
function sheet(start?: SheetSelection) {
  let selection = start ?? defaultSelection(PIZZA.optionGroups);
  const draw = () => nodes(ItemChoices({
    groups: PIZZA.optionGroups,
    selection,
    onChoose: (g, o) => { selection = chooseOption(PIZZA.optionGroups, selection, g, o); },
    onPlace: (g, o, p) => { selection = placeOption(PIZZA.optionGroups, selection, g, o, p); },
  }));
  return {
    tree: draw,
    get selection() { return selection; },
    row: (optionId: string) => draw().find((n) => n.type === 'CheckRow' && n.props.testID === `menu-option-${optionId}`),
    tap(optionId: string) { this.row(optionId).props.onToggle(); },
    group: (groupId: string) => draw().find((n) => n.props?.testID === `menu-group-${groupId}`),
  };
}

describe('[MENU-OPTIONS] the phone item sheet', () => {
  it('each group says Required or Optional and how many to choose; a size row shows its price, an extra what it adds', () => {
    const s = sheet();
    const words = texts(s.tree());
    expect(words).toEqual(expect.arrayContaining(['Size', 'Required', 'Choose 1', 'Toppings', 'Optional', 'Choose up to 3']));
    expect(s.row('large').props).toMatchObject({ kind: 'radio', label: 'Large · $3,500', checked: false });
    expect(s.row('stuffed').props).toMatchObject({ kind: 'radio', label: 'Stuffed crust · +$500' });
    expect(s.row('thin').props).toMatchObject({ label: 'Thin', checked: true });
    expect(s.row('pep').props).toMatchObject({ kind: 'checkbox', label: 'Pepperoni · +$300' });
  });

  it('a sold-out topping is shown and cannot be tapped', () => {
    const s = sheet();
    expect(s.row('mush')).toBeUndefined();
    const soldOut = s.tree().find((n) => n.type === 'Chip' && n.props.label === 'Mushroom · sold out');
    expect(soldOut, 'shown').toBeTruthy();
    expect(soldOut.props.onPress, 'never tappable').toBeUndefined();
  });

  it('the follow-up group is not there until its opener is chosen, appears right under it, and its choice clears with it', () => {
    const s = sheet();
    s.tap('large');
    expect(s.group('cheese')).toBeUndefined();
    s.tap('stuffed');
    const crust = s.group('crust');
    const insideCrust = nodes(crust);
    expect(insideCrust.some((n) => n.props?.testID === 'menu-group-cheese'), 'drawn inside the Crust group, under Stuffed crust').toBe(true);
    s.tap('cheddar');
    expect(sheetUnitPrice(PIZZA, s.selection)).toBe(3500 + 500 + 100);
    s.tap('thin');
    expect(s.group('cheese')).toBeUndefined();
    expect(s.selection).toEqual({ size: ['large'], crust: ['thin'] });
    expect(sheetUnitPrice(PIZZA, s.selection)).toBe(3500);
  });

  it('a chosen topping gets Whole / Left half / Right half (Whole first) with the half’s price, and a half is priced at 50%', () => {
    const s = sheet();
    s.tap('personal');
    expect(s.tree().some((n) => n.type === 'Segmented')).toBe(false);
    s.tap('pep');
    const toggle = s.tree().find((n) => n.type === 'Segmented');
    expect(toggle.props.value).toBe('WHOLE');
    expect(toggle.props.options.map((o: { label: string }) => o.label)).toEqual(['Whole', 'Left half', 'Right half']);
    expect(texts(s.tree())).toContain('Whole +$300 · half +$150');
    toggle.props.onChange('LEFT');
    expect(s.selection['toppings']).toEqual(['pep:left']);
    expect(s.tree().find((n) => n.type === 'Segmented').props.value).toBe('LEFT');
    expect(sheetUnitPrice(PIZZA, s.selection)).toBe(1200 + 150);
  });
});

// [STORE-VAT-EXCLUSIVE · REVIEW-B S3-1] A standard-rated item of a store pricing before VAT: each choice's price says "+ VAT".
describe('[STORE-VAT-EXCLUSIVE] "+ VAT" beside a choice\'s price', () => {
  it('a size and an extra; nothing changes for any other item', () => {
    const size = group('g', 'Size', [], { setsPrice: true });
    const extras = group('e', 'Extras', [], { halfPricePercent: 50 });
    expect(choicePriceWords(size, opt('l', 'Large', 2500), true)).toBe('$2,500 + VAT');
    expect(choicePriceWords(extras, opt('c', 'Cheese', 300), true)).toBe('+$300 + VAT');
    expect(choicePriceWords(extras, opt('c', 'Cheese', 300))).toBe('+$300');
    expect(halfPriceWords(extras, opt('c', 'Cheese', 300), true)).toBe('Whole +$300 · half +$150 (+ VAT)');
  });
});
