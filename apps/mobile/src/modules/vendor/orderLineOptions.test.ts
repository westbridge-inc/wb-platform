import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { orderLineOptionsParts, orderLineOptionsText } from './orderLineOptions';

// [L09 · M026] The store makes what the customer chose: the order detail and
// the new-order takeover show each line's options under the item's name.

describe('a line\'s chosen options, as the store reads them', () => {
  it('names each choice under its group, in the order chosen', () => {
    expect(orderLineOptionsText([{ group: 'Size', name: 'Large' }, { group: 'Extras', name: 'Cheese' }])).toBe('Size: Large · Extras: Cheese');
  });

  it('a line with no options shows nothing', () => {
    expect(orderLineOptionsText([])).toBeNull();
    expect(orderLineOptionsText(undefined)).toBeNull();
    expect(orderLineOptionsText([{ group: 'Size', name: '' }])).toBeNull();
  });
});

// [MENU-OPTIONS · owner 11 Nov 2026] A pizza as the kitchen reads it: the size alone, a follow-up under the choice
// that opened it, and a half-and-half group laid out by half. The server sends each choice's parts (plainGroup,
// plainName, placement, parentOptionName, setsPrice) beside the display words; an older server sends only the words.
const pizza = [
  { group: 'Size', name: 'Large', plainGroup: 'Size', plainName: 'Large', placement: null, parentOptionName: null, setsPrice: true },
  { group: 'Crust', name: 'Stuffed crust', plainGroup: 'Crust', plainName: 'Stuffed crust', placement: null, parentOptionName: null, setsPrice: false },
  { group: 'Cheese (Stuffed crust)', name: 'Cheddar', plainGroup: 'Cheese', plainName: 'Cheddar', placement: null, parentOptionName: 'Stuffed crust', setsPrice: false },
  { group: 'Toppings', name: 'Pepperoni (left half)', plainGroup: 'Toppings', plainName: 'Pepperoni', placement: 'LEFT', parentOptionName: null, setsPrice: false },
  { group: 'Toppings', name: 'Onion', plainGroup: 'Toppings', plainName: 'Onion', placement: 'WHOLE', parentOptionName: null, setsPrice: false },
  { group: 'Toppings', name: 'Mushroom (right half)', plainGroup: 'Toppings', plainName: 'Mushroom', placement: 'RIGHT', parentOptionName: null, setsPrice: false },
] as const;

describe('[MENU-OPTIONS] a pizza, as the kitchen reads it', () => {
  it('size alone, the follow-up under its opener, toppings by half', () => {
    expect(orderLineOptionsText(pizza)).toBe(
      'Large · Crust: Stuffed crust → Cheese: Cheddar · Toppings — Left: Pepperoni / Right: Mushroom / Whole: Onion',
    );
  });

  it('the same pizza in parts, one per line of the kitchen ticket', () => {
    expect(orderLineOptionsParts(pizza)).toEqual([
      'Large',
      'Crust: Stuffed crust → Cheese: Cheddar',
      'Toppings — Left: Pepperoni / Right: Mushroom / Whole: Onion',
    ]);
  });

  it('several choices of one group read as one list; a half-and-half group with only whole choices needs no halves', () => {
    expect(orderLineOptionsText([
      { group: 'Toppings', name: 'Onion', plainGroup: 'Toppings', plainName: 'Onion', placement: 'WHOLE', parentOptionName: null, setsPrice: false },
      { group: 'Toppings', name: 'Peppers', plainGroup: 'Toppings', plainName: 'Peppers', placement: 'WHOLE', parentOptionName: null, setsPrice: false },
      { group: 'Extras', name: 'Garlic dip', plainGroup: 'Extras', plainName: 'Garlic dip', placement: null, parentOptionName: null, setsPrice: false },
    ])).toBe('Toppings: Onion, Peppers · Extras: Garlic dip');
  });

  it('two choices that each open the same follow-up group keep each follow-up under its own opener', () => {
    expect(orderLineOptionsText([
      { group: 'Sides', name: 'Wings', plainGroup: 'Sides', plainName: 'Wings', placement: null, parentOptionName: null, setsPrice: false },
      { group: 'Sauce (Wings)', name: 'BBQ', plainGroup: 'Sauce', plainName: 'BBQ', placement: null, parentOptionName: 'Wings', setsPrice: false },
      { group: 'Sides', name: 'Fries', plainGroup: 'Sides', plainName: 'Fries', placement: null, parentOptionName: null, setsPrice: false },
      { group: 'Sauce (Fries)', name: 'Garlic', plainGroup: 'Sauce', plainName: 'Garlic', placement: null, parentOptionName: 'Fries', setsPrice: false },
    ])).toBe('Sides: Wings → Sauce: BBQ · Sides: Fries → Sauce: Garlic');
  });

  it('an older server (display words only) reads as before: group: name for each choice', () => {
    expect(orderLineOptionsText([
      { group: 'Toppings', name: 'Pepperoni (left half)' },
      { group: 'Toppings', name: 'Onion' },
    ])).toBe('Toppings: Pepperoni (left half) · Toppings: Onion');
  });
});

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const DETAIL = strip(readFileSync(new URL('./screens/VendorOrderDetailScreen.tsx', import.meta.url), 'utf8'));
const TAKEOVER = strip(readFileSync(new URL('./NewOrderTakeover.tsx', import.meta.url), 'utf8'));

describe('both store order screens show the options', () => {
  it('the order detail shows each line\'s options', () => {
    expect(DETAIL).toContain('orderLineOptionsText(it.options)');
  });

  it('the new-order takeover shows each line\'s options', () => {
    expect(TAKEOVER).toContain('orderLineOptionsText(i.options)');
  });

  it('[MENU-OPTIONS] both lay a pizza out one group per line', () => {
    expect(DETAIL).toContain("orderLineOptionsParts(it.options).join('\\n')");
    expect(TAKEOVER).toContain("orderLineOptionsParts(i.options).join('\\n')");
  });
});
