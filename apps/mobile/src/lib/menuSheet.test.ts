import { describe, expect, it } from 'vitest';
import { MENU_OPTIONS_CAPABILITY, cartWriteCapabilities } from './menuOptionsCapability';
import {
  chooseOption, choiceId, choicePlacement, defaultSelection, encodeChoice, followUpFor,
  groupGuidance, hasSizes, isChosen, openedFollowUps, orderLineChoices, placeOption, placementOf, restoreSelection, topLevelGroups,
  wireSelection, type SheetGroup, type SheetOption,
} from './menuSheet';
import { selectionProblem, sheetUnitPrice } from './menuPrice';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] The customer item sheet: size sets the price, half-and-half, a follow-up group
// that opens under its opener and clears when it is unchosen, required / min / max, sold out, the selection as the
// API reads it, and an order line read back. Synthetic menu only.
// ---------------------------------------------------------------------------

const opt = (id: string, name: string, additionalPrice: number, extra: Partial<SheetOption> = {}): SheetOption =>
  ({ id, name, additionalPrice, isAvailable: true, isDefault: false, sortOrder: 0, followUpGroupId: null, ...extra });
const group = (id: string, name: string, options: SheetOption[], extra: Partial<SheetGroup> = {}): SheetGroup =>
  ({ id, name, isRequired: false, minSelect: 0, maxSelect: 1, sortOrder: 0, setsPrice: false, allowHalves: false, halfPricePercent: 100, options, ...extra });

function pizza(o: { halfPricePercent?: number; mushroomAvailable?: boolean; cheeseDefault?: boolean } = {}) {
  return {
    basePrice: 1200,
    customerPrice: 1200,
    optionGroups: [
      group('size', 'Size', [opt('personal', 'Personal', 1200), opt('medium', 'Medium', 2500, { sortOrder: 1 }), opt('large', 'Large', 3500, { sortOrder: 2 })],
        { setsPrice: true, isRequired: true, minSelect: 1, sortOrder: 0 }),
      group('crust', 'Crust', [opt('thin', 'Thin', 0, { isDefault: true }), opt('stuffed', 'Stuffed crust', 500, { followUpGroupId: 'cheese', sortOrder: 1 })],
        { isRequired: true, minSelect: 1, sortOrder: 1 }),
      group('cheese', 'Cheese', [opt('mozz', 'Mozzarella', 0, { isDefault: o.cheeseDefault ?? false }), opt('cheddar', 'Cheddar', 100, { sortOrder: 1 })],
        { isRequired: true, minSelect: 1, sortOrder: 2 }),
      group('toppings', 'Toppings', [
        opt('pep', 'Pepperoni', 300), opt('mush', 'Mushroom', 175, { sortOrder: 1, isAvailable: o.mushroomAvailable ?? true }), opt('onion', 'Onion', 100, { sortOrder: 2 }),
      ], { allowHalves: true, halfPricePercent: o.halfPricePercent ?? 50, maxSelect: 3, sortOrder: 3 }),
    ],
  };
}

const tap = (item: ReturnType<typeof pizza>, steps: Array<[string, string]>, start = defaultSelection(item.optionGroups)) =>
  steps.reduce((sel, [g, o]) => chooseOption(item.optionGroups, sel, g, o), start);

describe('[MENU-OPTIONS] size sets the price', () => {
  it('the chosen size IS the unit price; extras add on top; nothing is a size until one is chosen', () => {
    const item = pizza();
    let sel = defaultSelection(item.optionGroups);
    expect(sel).toEqual({ crust: ['thin'] });
    expect(selectionProblem(item, sel)).toBe('Please choose an option for "Size"');
    sel = tap(item, [['size', 'large']], sel);
    expect(sheetUnitPrice(item, sel)).toBe(3500);
    sel = tap(item, [['toppings', 'onion']], sel);
    expect(sheetUnitPrice(item, sel)).toBe(3600);
    // A second size replaces the first, never adds to it.
    sel = tap(item, [['size', 'medium']], sel);
    expect(sel['size']).toEqual(['medium']);
    expect(sheetUnitPrice(item, sel)).toBe(2600);
    expect(selectionProblem(item, sel)).toBeNull();
  });

  it('a size cannot be taken back with a second tap (the item needs one), and is required even when the store left it optional', () => {
    const item = pizza();
    const sel = tap(item, [['size', 'large'], ['size', 'large']]);
    expect(sel['size']).toEqual(['large']);
    item.optionGroups[0]!.isRequired = false;
    expect(groupGuidance(item.optionGroups[0]!)).toBe('Choose 1');
    expect(selectionProblem(item, { crust: ['thin'] })).toBe('Please choose an option for "Size"');
  });

  it('the item is listed as "From" its smallest size', () => {
    expect(hasSizes(pizza())).toBe(true);
    expect(hasSizes({ optionGroups: [group('extras', 'Extras', [])] })).toBe(false);
    expect(hasSizes({})).toBe(false);
  });
});

describe('[MENU-OPTIONS] half-and-half', () => {
  it('a new topping goes on the whole pizza; Left / Right make it a half, priced at the store’s percent', () => {
    const item = pizza();
    let sel = tap(item, [['size', 'personal'], ['toppings', 'pep'], ['toppings', 'mush'], ['toppings', 'onion']]);
    expect(placementOf(sel, 'toppings', 'pep')).toBe('WHOLE');
    sel = placeOption(item.optionGroups, sel, 'toppings', 'pep', 'LEFT');
    sel = placeOption(item.optionGroups, sel, 'toppings', 'mush', 'RIGHT');
    expect(sel['toppings']).toEqual(['pep:left', 'mush:right', 'onion']);
    expect(sheetUnitPrice(item, sel)).toBe(1200 + 150 + 88 + 100);
    sel = placeOption(item.optionGroups, sel, 'toppings', 'pep', 'WHOLE');
    expect(sel['toppings']).toEqual(['pep', 'mush:right', 'onion']);
    expect(sheetUnitPrice(item, sel)).toBe(1200 + 300 + 88 + 100);
  });

  it('at 100% a half costs the full price', () => {
    const item = pizza({ halfPricePercent: 100 });
    const sel = placeOption(item.optionGroups, tap(item, [['size', 'personal'], ['toppings', 'pep']]), 'toppings', 'pep', 'LEFT');
    expect(sheetUnitPrice(item, sel)).toBe(1500);
  });

  it('a half is never placed where the group has no halves, nor on a topping not chosen', () => {
    const item = pizza();
    const sel = tap(item, [['size', 'large']]);
    expect(placeOption(item.optionGroups, sel, 'crust', 'thin', 'LEFT')).toBe(sel);
    expect(placeOption(item.optionGroups, sel, 'toppings', 'pep', 'LEFT')).toBe(sel);
  });

  it('unchoosing a half topping takes it off whichever half it was on', () => {
    const item = pizza();
    let sel = placeOption(item.optionGroups, tap(item, [['size', 'large'], ['toppings', 'pep']]), 'toppings', 'pep', 'RIGHT');
    sel = chooseOption(item.optionGroups, sel, 'toppings', 'pep');
    expect(sel['toppings']).toBeUndefined();
  });
});

describe('[MENU-OPTIONS] a follow-up group opens under its opener and clears without it', () => {
  it('Stuffed crust opens Cheese, which is then required; Thin closes it and its choice goes', () => {
    const item = pizza();
    const groups = item.optionGroups;
    expect(topLevelGroups(groups).map((g) => g.id)).toEqual(['size', 'crust', 'toppings']);
    expect(followUpFor(groups, groups[1]!, groups[1]!.options[1]!)?.id).toBe('cheese');
    expect(followUpFor(groups, groups[1]!, groups[1]!.options[0]!)).toBeNull();
    let sel = tap(item, [['size', 'medium'], ['crust', 'stuffed']]);
    expect(openedFollowUps(groups, sel)).toEqual(new Set(['cheese']));
    expect(selectionProblem(item, sel)).toBe('Please choose an option for "Cheese"');
    sel = tap(item, [['cheese', 'cheddar']], sel);
    expect(sheetUnitPrice(item, sel)).toBe(2500 + 500 + 100);
    expect(selectionProblem(item, sel)).toBeNull();
    sel = tap(item, [['crust', 'thin']], sel);
    expect(sel).toEqual({ size: ['medium'], crust: ['thin'] });
    expect(openedFollowUps(groups, sel).size).toBe(0);
    expect(sheetUnitPrice(item, sel)).toBe(2500);
  });

  it('a choice in a follow-up group that is not open changes nothing', () => {
    const item = pizza();
    const sel = tap(item, [['size', 'medium']]);
    expect(chooseOption(item.optionGroups, sel, 'cheese', 'cheddar')).toBe(sel);
  });

  it('opening a follow-up group brings the store’s pre-selected choice with it', () => {
    const item = pizza({ cheeseDefault: true });
    expect(tap(item, [['size', 'medium'], ['crust', 'stuffed']])).toEqual({ size: ['medium'], crust: ['stuffed'], cheese: ['mozz'] });
  });
});

describe('[MENU-OPTIONS] required, minimum, maximum, sold out', () => {
  it('the words under each group', () => {
    expect(groupGuidance(group('a', 'A', [], { isRequired: true, minSelect: 1 }))).toBe('Choose 1');
    expect(groupGuidance(group('a', 'A', [], { maxSelect: 1 }))).toBe('Choose up to 1');
    expect(groupGuidance(group('a', 'A', [], { maxSelect: 3 }))).toBe('Choose up to 3');
    expect(groupGuidance(group('a', 'A', [], { isRequired: true, minSelect: 2, maxSelect: 2 }))).toBe('Choose 2');
    expect(groupGuidance(group('a', 'A', [], { isRequired: true, minSelect: 1, maxSelect: 3 }))).toBe('Choose 1–3');
  });

  it('a fourth topping is not taken where three is the most', () => {
    const item = pizza();
    item.optionGroups[3]!.options.push(opt('olive', 'Olive', 100, { sortOrder: 3 }));
    const sel = tap(item, [['size', 'large'], ['toppings', 'pep'], ['toppings', 'mush'], ['toppings', 'onion']]);
    expect(chooseOption(item.optionGroups, sel, 'toppings', 'olive')).toBe(sel);
  });

  it('a sold-out choice is never chosen nor pre-selected', () => {
    const item = pizza({ mushroomAvailable: false });
    const sel = tap(item, [['size', 'large']]);
    expect(chooseOption(item.optionGroups, sel, 'toppings', 'mush')).toBe(sel);
    item.optionGroups[1]!.options[0]!.isAvailable = false;
    expect(defaultSelection(item.optionGroups)).toEqual({});
  });

  it('an optional pick-one group is taken back with a second tap; a required one is not', () => {
    const extras = group('drink', 'Drink', [opt('cola', 'Cola', 200)]);
    const sel = chooseOption([extras], {}, 'drink', 'cola');
    expect(isChosen(sel, 'drink', 'cola')).toBe(true);
    expect(chooseOption([extras], sel, 'drink', 'cola')).toEqual({});
    const req = { ...extras, isRequired: true, minSelect: 1 };
    expect(chooseOption([req], sel, 'drink', 'cola')).toBe(sel);
  });
});

describe('[MENU-OPTIONS] the selection as the API reads it', () => {
  it('a choice is the id, id:left or id:right', () => {
    expect(encodeChoice('pep', 'WHOLE')).toBe('pep');
    expect(encodeChoice('pep', 'LEFT')).toBe('pep:left');
    expect(encodeChoice('pep', 'RIGHT')).toBe('pep:right');
    expect(choiceId('pep:left')).toBe('pep');
    expect(choicePlacement('pep:right')).toBe('RIGHT');
    expect(choiceId('a:b')).toBe('a:b');
    expect(choicePlacement('a:b')).toBe('WHOLE');
  });

  it('a pick-one group is sent as one choice, any other as a list; empty groups are left out', () => {
    const item = pizza();
    const sel = placeOption(item.optionGroups, tap(item, [['size', 'large'], ['crust', 'stuffed'], ['cheese', 'cheddar'], ['toppings', 'pep']]), 'toppings', 'pep', 'LEFT');
    expect(wireSelection(item.optionGroups, { ...sel, extra: [] })).toEqual({ size: 'large', crust: 'stuffed', cheese: 'cheddar', toppings: ['pep:left'] });
  });

  it('a kept selection is restored against today’s menu: sold out, unknown, impossible halves and closed follow-ups go', () => {
    const item = pizza({ mushroomAvailable: false });
    expect(restoreSelection(item.optionGroups, { size: 'large', crust: 'thin', cheese: 'cheddar', toppings: ['pep:left', 'mush', 'ghost', 'onion:right'] }))
      .toEqual({ size: ['large'], crust: ['thin'], toppings: ['pep:left', 'onion:right'] });
    expect(restoreSelection(item.optionGroups, { size: 'large:left', crust: ['stuffed'], cheese: ['cheddar'] }))
      .toEqual({ crust: ['stuffed'], cheese: ['cheddar'] });
    expect(restoreSelection(item.optionGroups, 'nonsense')).toEqual({});
  });

  it('every cart write declares MENU_OPTIONS_V2', () => {
    expect(MENU_OPTIONS_CAPABILITY).toBe('MENU_OPTIONS_V2');
    expect(cartWriteCapabilities()).toEqual(['MENU_OPTIONS_V2']);
  });
});

describe('[MENU-OPTIONS] an order line read back', () => {
  it('size, crust, the follow-up under its opener, and a half-and-half group laid out by half', () => {
    expect(orderLineChoices([
      { group: 'Size', name: 'Large', plainGroup: 'Size', plainName: 'Large', placement: null, parentOptionName: null, setsPrice: true },
      { group: 'Crust', name: 'Stuffed crust', plainGroup: 'Crust', plainName: 'Stuffed crust', placement: null, parentOptionName: null },
      { group: 'Cheese (Stuffed crust)', name: 'Cheddar', plainGroup: 'Cheese', plainName: 'Cheddar', placement: null, parentOptionName: 'Stuffed crust' },
      { group: 'Toppings', name: 'Pepperoni (left half)', plainGroup: 'Toppings', plainName: 'Pepperoni', placement: 'LEFT', parentOptionName: null },
      { group: 'Toppings', name: 'Mushroom (right half)', plainGroup: 'Toppings', plainName: 'Mushroom', placement: 'RIGHT', parentOptionName: null },
      { group: 'Toppings', name: 'Onion', plainGroup: 'Toppings', plainName: 'Onion', placement: 'WHOLE', parentOptionName: null },
    ])).toEqual([
      { text: 'Size: Large', followUp: false },
      { text: 'Crust: Stuffed crust', followUp: false },
      { text: 'Cheese: Cheddar', followUp: true },
      { text: 'Toppings — Whole: Onion / Left: Pepperoni / Right: Mushroom', followUp: false },
    ]);
  });

  it('an older order (group and name only) reads "group: name", choices of one group together', () => {
    expect(orderLineChoices([{ group: 'Extras', name: 'Egg' }, { group: 'Extras', name: 'Cheese' }, { group: 'Size', name: 'Large' }])).toEqual([
      { text: 'Extras: Egg, Cheese', followUp: false },
      { text: 'Size: Large', followUp: false },
    ]);
    expect(orderLineChoices(undefined)).toEqual([]);
    expect(orderLineChoices([{ group: 'Extras', name: '' }])).toEqual([]);
  });

  it('a half-and-half group with every topping on the whole pizza reads as a plain list', () => {
    expect(orderLineChoices([
      { plainGroup: 'Toppings', plainName: 'Onion', placement: 'WHOLE' },
      { plainGroup: 'Toppings', plainName: 'Pepperoni', placement: 'WHOLE' },
    ])).toEqual([{ text: 'Toppings: Onion, Pepperoni', followUp: false }]);
  });
});
