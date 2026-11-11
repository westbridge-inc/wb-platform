import { describe, it, expect } from 'vitest';
import {
  halfPrice, itemNeedsMenuOptionsV2, declaresMenuOptionsV2, lineOptionsIssue, MENU_OPTIONS_CAPABILITY,
  OptionSelectionError, rebuildSelectionFromSnapshot, resolveSelectedOptions, selectionKey, validateSelectedOptions,
  type ValidatableGroup,
} from '../modules/order/options';
import { priceCartLine } from '../modules/order/cart-plans';
import { itemOptionRulesProblem } from '../modules/vendor/modifier-library';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] Pizza-grade options, priced by the SERVER only:
//  - size sets the price (the chosen size IS the item price; extras add on top);
//  - half-and-half (whole / left / right) with the store's half price rule;
//  - nested follow-up choices one level deep (only while the opener is chosen);
//  - required / min / max / sold out, and a tampered client never changes a price.
// ---------------------------------------------------------------------------

type G = ValidatableGroup & { sortOrder: number; setsPrice: boolean; allowHalves: boolean; halfPricePercent: number; options: Array<ValidatableGroup['options'][number] & { followUpGroupId: string | null; sortOrder: number }> };

const opt = (id: string, name: string, price: number, extra: Partial<{ followUpGroupId: string | null; isAvailable: boolean; sortOrder: number }> = {}) =>
  ({ id, name, additionalPrice: price, isAvailable: extra.isAvailable ?? true, followUpGroupId: extra.followUpGroupId ?? null, sortOrder: extra.sortOrder ?? 0 });

function group(id: string, name: string, options: G['options'], extra: Partial<Omit<G, 'id' | 'name' | 'options'>> = {}): G {
  return {
    id, name, options,
    isRequired: extra.isRequired ?? false, minSelect: extra.minSelect ?? 0, maxSelect: extra.maxSelect ?? 1,
    sortOrder: extra.sortOrder ?? 0, setsPrice: extra.setsPrice ?? false, allowHalves: extra.allowHalves ?? false,
    halfPricePercent: extra.halfPricePercent ?? 100,
  };
}

/** A Pizza Hut-style pizza: Size sets the price, Crust (Stuffed opens Cheese), Toppings half-and-half at 50%. */
function pizza(overrides: { halfPricePercent?: number; cheeseRequired?: boolean; mushroomAvailable?: boolean } = {}) {
  return {
    basePrice: 1200, // the "from" price (lowest size): never what a sized line costs
    optionGroups: [
      group('size', 'Size', [opt('personal', 'Personal', 1200, { sortOrder: 0 }), opt('medium', 'Medium', 2500, { sortOrder: 1 }), opt('large', 'Large', 3500, { sortOrder: 2 })],
        { setsPrice: true, isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 0 }),
      group('crust', 'Crust', [opt('thin', 'Thin', 0, { sortOrder: 0 }), opt('stuffed', 'Stuffed crust', 500, { followUpGroupId: 'cheese', sortOrder: 1 })],
        { isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 1 }),
      group('cheese', 'Cheese', [opt('mozz', 'Mozzarella', 0, { sortOrder: 0 }), opt('cheddar', 'Cheddar', 100, { sortOrder: 1 })],
        { isRequired: overrides.cheeseRequired ?? true, minSelect: 1, maxSelect: 1, sortOrder: 2 }),
      group('toppings', 'Toppings', [
        opt('pep', 'Pepperoni', 300, { sortOrder: 0 }),
        opt('mush', 'Mushroom', 175, { sortOrder: 1, isAvailable: overrides.mushroomAvailable ?? true }),
        opt('onion', 'Onion', 100, { sortOrder: 2 }),
      ], { allowHalves: true, halfPricePercent: overrides.halfPricePercent ?? 50, maxSelect: 3, sortOrder: 3 }),
    ],
  };
}

const reasonOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof OptionSelectionError) return e.reason; throw e; }
  return null;
};

const line = (selection: unknown, quantity = 1, item = pizza()) => priceCartLine({ quantity, selectedOptions: selection, item });

describe('[MENU-OPTIONS] size sets the price', () => {
  it('the chosen size IS the unit price; extras add on top; quantity multiplies', () => {
    const sel = validateSelectedOptions(pizza(), { size: 'large', crust: 'thin', toppings: ['onion'] }).selection;
    const priced = line(sel, 2);
    expect(priced.basePrice).toBe(3500);
    expect(priced.unitPrice).toBe(3600);
    expect(priced.lineTotal).toBe(7200);
    const size = priced.options.find((o) => o.setsPrice)!;
    expect(size).toMatchObject({ optionGroupName: 'Size', optionName: 'Large', additionalPrice: 0, listedPrice: 3500, setsPrice: true });
  });

  it('never prices a size as an add-on over the item price (the legacy reading would charge 1200 + 2500)', () => {
    expect(line({ size: 'medium', crust: 'thin' }).unitPrice).toBe(2500);
  });

  it('a size is required even when the group was not marked required', () => {
    const item = pizza();
    item.optionGroups[0]!.isRequired = false;
    item.optionGroups[0]!.minSelect = 0;
    expect(reasonOf(() => validateSelectedOptions(item, { crust: 'thin' }))).toBe('OPTION_REQUIRED');
  });

  it('two sizes are refused', () => {
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: ['large', 'medium'], crust: 'thin' }))).toBe('OPTION_LIMIT');
  });

  it('a legacy item (no rule set) prices exactly as before: base + every choice', () => {
    const legacy = { basePrice: 1000, optionGroups: [group('s', 'Size', [opt('l', 'Large', 300)], { isRequired: true, minSelect: 1 }), group('x', 'Extras', [opt('c', 'Cheese', 150)], { maxSelect: 2 })] };
    const sel = validateSelectedOptions(legacy, { s: 'l', x: ['c'] }).selection;
    expect(priceCartLine({ quantity: 1, selectedOptions: sel, item: legacy })).toMatchObject({ basePrice: 1000, unitPrice: 1450 });
    expect(itemNeedsMenuOptionsV2(legacy)).toBe(false);
  });
});

describe('[MENU-OPTIONS] half-and-half', () => {
  it('left and right halves cost the store percent of the choice (half-up to the dollar); whole costs full', () => {
    const sel = validateSelectedOptions(pizza(), { size: 'personal', crust: 'thin', toppings: ['pep:left', 'mush:right', 'onion'] }).selection;
    const priced = line(sel);
    // 1200 + 300×50% + 175×50% (87.5 → 88) + 100 whole
    expect(priced.unitPrice).toBe(1200 + 150 + 88 + 100);
    const tops = priced.options.filter((o) => o.plainGroupName === 'Toppings');
    expect(tops.map((o) => [o.placement, o.optionName, o.additionalPrice, o.listedPrice])).toEqual([
      ['LEFT', 'Pepperoni (left half)', 150, 300],
      ['RIGHT', 'Mushroom (right half)', 88, 175],
      ['WHOLE', 'Onion', 100, 100],
    ]);
  });

  it('a 100% rule charges a half the full price', () => {
    const sel = validateSelectedOptions(pizza({ halfPricePercent: 100 }), { size: 'personal', crust: 'thin', toppings: ['pep:left'] }).selection;
    expect(line(sel, 1, pizza({ halfPricePercent: 100 })).unitPrice).toBe(1500);
  });

  it('halfPrice rounds half-up to the whole dollar, exactly, and 100% keeps cents', () => {
    expect(halfPrice(175, 50)).toBe(88);
    expect(halfPrice(301, 50)).toBe(151);
    expect(halfPrice(300, 33)).toBe(99);
    expect(halfPrice(175.5, 100)).toBe(175.5);
    expect(halfPrice(200, 0)).toBe(200); // an impossible rule falls back to full price, never free
  });

  it('a half is refused where the group does not allow halves (the crust, the size)', () => {
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: 'large:left', crust: 'thin' }))).toBe('OPTION_PLACEMENT');
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: 'large', crust: 'thin:right' }))).toBe('OPTION_PLACEMENT');
  });

  it('the same topping on both halves is one choice twice (use whole)', () => {
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: 'large', crust: 'thin', toppings: ['pep:left', 'pep:right'] }))).toBe('OPTION_DUPLICATE');
  });

  it('":whole" is written as the bare id; the selection is canonical whatever order it came in', () => {
    const a = validateSelectedOptions(pizza(), { toppings: ['onion:whole', 'pep:left'], crust: 'thin', size: 'large' }).selection;
    const b = validateSelectedOptions(pizza(), { size: 'large', crust: 'thin', toppings: ['pep:left', 'onion'] }).selection;
    expect(a).toEqual({ crust: 'thin', size: 'large', toppings: ['onion', 'pep:left'] });
    expect(selectionKey(a)).toBe(selectionKey(b));
    // Left and right of the same pizza are different lines.
    const c = validateSelectedOptions(pizza(), { size: 'large', crust: 'thin', toppings: ['pep:right', 'onion'] }).selection;
    expect(selectionKey(c)).not.toBe(selectionKey(a));
  });
});

describe('[MENU-OPTIONS] nested follow-up choices (one level)', () => {
  it('a follow-up choice is priced and shown under its opener, right after it', () => {
    const sel = validateSelectedOptions(pizza(), { size: 'medium', crust: 'stuffed', cheese: 'cheddar' }).selection;
    const priced = line(sel);
    expect(priced.unitPrice).toBe(2500 + 500 + 100);
    expect(priced.options.map((o) => o.optionGroupName)).toEqual(['Size', 'Crust', 'Cheese (Stuffed crust)']);
    expect(priced.options[2]).toMatchObject({ parentOptionName: 'Stuffed crust', plainGroupName: 'Cheese', optionName: 'Cheddar', placement: null });
  });

  it('the follow-up is required only while its opener is chosen', () => {
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: 'medium', crust: 'stuffed' }))).toBe('OPTION_REQUIRED');
    expect(validateSelectedOptions(pizza(), { size: 'medium', crust: 'thin' }).selection).toEqual({ crust: 'thin', size: 'medium' });
  });

  it('a follow-up choice without its opener is refused (a tampered or stale client)', () => {
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: 'medium', crust: 'thin', cheese: 'cheddar' }))).toBe('OPTION_FOLLOW_UP');
  });

  it('the quote marks such a line so the app asks to choose again', () => {
    expect(lineOptionsIssue(pizza(), { size: 'medium', crust: 'thin', cheese: 'cheddar' })).toBe('Your choices need updating — remove and choose again');
  });
});

describe('[MENU-OPTIONS] required, limits, sold out', () => {
  it('max: a fourth topping is refused', () => {
    const item = pizza();
    item.optionGroups[3]!.options.push(opt('olive', 'Olive', 50, { sortOrder: 3 }));
    expect(reasonOf(() => validateSelectedOptions(item, { size: 'large', crust: 'thin', toppings: ['pep', 'mush', 'onion', 'olive'] }))).toBe('OPTION_LIMIT');
  });

  it('a required group left empty is refused', () => {
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: 'large' }))).toBe('OPTION_REQUIRED');
  });

  it('a sold-out topping is refused on any half', () => {
    expect(reasonOf(() => validateSelectedOptions(pizza({ mushroomAvailable: false }), { size: 'large', crust: 'thin', toppings: ['mush:left'] }))).toBe('OPTION_UNAVAILABLE');
    expect(lineOptionsIssue(pizza({ mushroomAvailable: false }), { size: 'large', crust: 'thin', toppings: ['mush:left'] })).toBe('Mushroom is sold out — remove and choose again');
  });
});

describe('[MENU-OPTIONS] the server is the only price authority (tampered clients)', () => {
  it('a choice from another item, an unknown group, or a made-up suffix never prices', () => {
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: 'large', crust: 'thin', evil: 'x' }))).toBe('OPTION_UNKNOWN');
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: 'other-items-size', crust: 'thin' }))).toBe('OPTION_UNKNOWN');
    expect(reasonOf(() => validateSelectedOptions(pizza(), { size: 'large', crust: 'thin', toppings: ['pep:free'] }))).toBe('OPTION_UNKNOWN');
    // The lenient quote reader ignores what is not the item's and still prices the size as the base.
    expect(line({ size: 'large', crust: 'thin', evil: ['ghost:left'] }).unitPrice).toBe(3500);
  });

  it('a client-sent price is not an input: only ids and placements are read', () => {
    const forged = { size: 'large', crust: 'thin', toppings: ['pep:left'], price: 1, additionalPrice: 0 } as Record<string, unknown>;
    expect(reasonOf(() => validateSelectedOptions(pizza(), forged))).toBe('OPTION_UNKNOWN');
    const sel = validateSelectedOptions(pizza(), { size: 'large', crust: 'thin', toppings: ['pep:left'] }).selection;
    expect(line(sel).unitPrice).toBe(3650);
  });

  it('a size is never discounted by sending it as a half', () => {
    expect(line({ size: 'large:left', crust: 'thin' }).unitPrice).toBe(3500);
  });
});

describe('[MENU-OPTIONS] reorder rebuilds placements and follow-ups from the order snapshot', () => {
  it('names + placements + opener come back as the same canonical selection', () => {
    const { selection, options } = validateSelectedOptions(pizza(), { size: 'large', crust: 'stuffed', cheese: 'mozz', toppings: ['pep:left', 'mush:right'] });
    const snapshot = options.map((o) => ({ optionGroupName: o.optionGroupName, optionName: o.optionName, plainGroupName: o.plainGroupName, plainOptionName: o.plainOptionName, placement: o.placement, parentOptionName: o.parentOptionName }));
    expect(rebuildSelectionFromSnapshot(pizza(), snapshot)).toEqual(selection);
  });

  it('a legacy snapshot (no parts) still rebuilds from the display words', () => {
    const legacy = { optionGroups: [group('s', 'Size', [opt('l', 'Large', 300)], { isRequired: true, minSelect: 1 })] };
    expect(rebuildSelectionFromSnapshot(legacy, [{ optionGroupName: 'Size', optionName: 'Large' }])).toEqual({ s: 'l' });
  });
});

describe('[MENU-OPTIONS] older apps', () => {
  it('an item with a size that sets the price, halves or a follow-up needs the capability; a plain item does not', () => {
    expect(itemNeedsMenuOptionsV2(pizza())).toBe(true);
    const onlyHalves = { optionGroups: [group('t', 'Toppings', [opt('p', 'P', 1)], { allowHalves: true })] };
    const onlyNested = { optionGroups: [group('a', 'A', [opt('x', 'X', 1, { followUpGroupId: 'b' })]), group('b', 'B', [opt('y', 'Y', 1)])] };
    expect(itemNeedsMenuOptionsV2(onlyHalves)).toBe(true);
    expect(itemNeedsMenuOptionsV2(onlyNested)).toBe(true);
    expect(declaresMenuOptionsV2([MENU_OPTIONS_CAPABILITY])).toBe(true);
    expect(declaresMenuOptionsV2(undefined)).toBe(false);
    expect(declaresMenuOptionsV2('MENU_OPTIONS_V2')).toBe(false);
  });
});

describe('[MENU-OPTIONS] the item rules the store tools are held to', () => {
  const g = (id: string, extra: Partial<Parameters<typeof itemOptionRulesProblem>[0][number]> = {}) => ({
    id, name: id, isRequired: false, minSelect: 0, maxSelect: 1, setsPrice: false, allowHalves: false, halfPricePercent: 100, options: [], ...extra,
  });
  it('accepts the pizza', () => {
    expect(itemOptionRulesProblem(pizza().optionGroups.map((x) => ({ ...x, options: x.options.map((o) => ({ id: o.id, name: o.name, followUpGroupId: o.followUpGroupId })) })))).toBeNull();
  });
  it('refuses two price-setting groups, a size that is not pick-one, a half-and-half size', () => {
    expect(itemOptionRulesProblem([g('a', { setsPrice: true, isRequired: true }), g('b', { setsPrice: true, isRequired: true })])).toMatch(/only one group that sets the price/);
    expect(itemOptionRulesProblem([g('a', { setsPrice: true, isRequired: false })])).toMatch(/exactly one/);
    expect(itemOptionRulesProblem([g('a', { setsPrice: true, isRequired: true, allowHalves: true })])).toMatch(/cannot be half-and-half/);
  });
  it('refuses a follow-up two levels deep, onto a size, onto its own group, or off the item', () => {
    expect(itemOptionRulesProblem([g('a', { options: [{ id: 'x', name: 'X', followUpGroupId: 'b' }] }), g('b', { options: [{ id: 'y', name: 'Y', followUpGroupId: 'c' }] }), g('c')])).toMatch(/one level only/);
    expect(itemOptionRulesProblem([g('a', { options: [{ id: 'x', name: 'X', followUpGroupId: 's' }] }), g('s', { setsPrice: true, isRequired: true })])).toMatch(/always shown/);
    expect(itemOptionRulesProblem([g('a', { options: [{ id: 'x', name: 'X', followUpGroupId: 'a' }] })])).toMatch(/its own group/);
    expect(itemOptionRulesProblem([g('a', { options: [{ id: 'x', name: 'X', followUpGroupId: 'zz' }] })])).toMatch(/not on this item/);
  });
  it('refuses a half rule outside 1-100% and a minimum above the maximum', () => {
    expect(itemOptionRulesProblem([g('a', { allowHalves: true, halfPricePercent: 0 })])).toMatch(/1% to 100%/);
    expect(itemOptionRulesProblem([g('a', { minSelect: 3, maxSelect: 2 })])).toMatch(/minimum/);
  });
});

describe('[MENU-OPTIONS] the lenient reader keeps legacy fixtures working', () => {
  it('groups without ids or pizza flags price as before', () => {
    const r = resolveSelectedOptions({ optionGroups: [{ name: 'Size', options: [{ id: 'lg', name: 'Large', additionalPrice: 500 }] }] }, { anything: ['lg'] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ optionGroupName: 'Size', optionName: 'Large', additionalPrice: 500, placement: null, setsPrice: false });
  });
});
