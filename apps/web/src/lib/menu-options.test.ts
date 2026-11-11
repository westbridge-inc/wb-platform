import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as server from '../../../api/src/modules/order/options';
import * as phoneSheet from '../../../mobile/src/lib/menuSheet';
import {
  chooseOption, defaultSelection, fromPrice, halfPrice, needsChoices, opensChoices, orderLineChoices, requiredChoiceSoldOut, selectionComplete,
  selectionNames, selectionPrice, validateSelectedOptions, OptionSelectionError,
} from './menu-options';

// [W6] The website judges and prices an item's choices with the API's own
// module — the same functions, not a copy — so the store page can never accept
// or price a selection differently from cart add, cart update and checkout.

const group = (id: string, isRequired: boolean, minSelect: number, maxSelect: number, prices: Array<[string, string, boolean?]>) => ({
  id, name: id, isRequired, minSelect, maxSelect,
  options: prices.map(([optionId, additionalPrice, isAvailable = true]) => ({ id: optionId, name: optionId, additionalPrice, isAvailable, isDefault: false })),
});

describe('[W6] the store page uses the server’s option rules', () => {
  it('is the API’s validator and resolver themselves, never a second copy', () => {
    expect(validateSelectedOptions).toBe(server.validateSelectedOptions);
    expect(OptionSelectionError).toBe(server.OptionSelectionError);
    const storePage = readFileSync(join(process.cwd(), 'src/components/storefront/storefront-experience.tsx'), 'utf8');
    expect(storePage).toMatch(/validateSelectedOptions,\n\} from '@\/lib\/menu-options'/);
  });

  it('accepts exactly what the server accepts', () => {
    const item = { optionGroups: [group('size', true, 1, 1, [['s', '0'], ['l', '400']]), group('extras', false, 2, 3, [['a', '100'], ['b', '100'], ['c', '50']])] };
    expect(selectionComplete(item, { size: ['s'] })).toBe(true);
    expect(selectionComplete(item, { size: [] })).toBe(false);
    expect(selectionComplete(item, { size: ['s'], extras: ['a'] })).toBe(false);
    expect(selectionComplete(item, { size: ['s'], extras: ['a', 'b'] })).toBe(true);
    const selections: Array<Record<string, string[]>> = [{ size: ['s'] }, { size: [] }, { size: ['s'], extras: ['a'] }, { size: ['s', 's'] }, { other: ['x'] }];
    for (const selected of selections) {
      let serverAccepts = true;
      try { server.validateSelectedOptions(item, selected); } catch { serverAccepts = false; }
      expect(selectionComplete(item, selected), JSON.stringify(selected)).toBe(serverAccepts);
    }
  });
});

describe('[W6] "From" and the sheet’s price', () => {
  it('From is the item plus the cheapest choices each required group needs, counting only choices on sale', () => {
    const item = { basePrice: 1000, optionGroups: [
      group('size', true, 1, 1, [['l', '400'], ['m', '200'], ['s', '0', false]]),
      group('sides', true, 2, 3, [['a', '300'], ['b', '100'], ['c', '150']]),
      group('extras', false, 0, 3, [['x', '50']]),
    ] };
    expect(fromPrice(item)).toBe(1000 + 200 + 100 + 150);
    expect(needsChoices(item)).toBe(true);
  });

  it('an item with no required group has no From: its price is the one-tap price', () => {
    const item = { basePrice: 800, optionGroups: [group('extras', false, 2, 3, [['x', '50']])] };
    expect(needsChoices(item)).toBe(false);
    expect(fromPrice(item)).toBe(800);
  });

  it('a figure the server sent that cannot be read is never priced as zero', () => {
    expect(fromPrice({ basePrice: Number.NaN })).toBeNull();
    expect(fromPrice({ basePrice: 800, optionGroups: [group('size', true, 1, 1, [['l', 'abc']])] })).toBeNull();
    expect(selectionPrice({ basePrice: 800, optionGroups: [group('size', true, 1, 1, [['l', 'abc']])] }, { size: ['l'] })).toBeNull();
  });

  it('an item a required choice is sold out for has no From price: nobody can order it at any price right now', () => {
    // Every size sold out.
    expect(fromPrice({ basePrice: 800, optionGroups: [group('size', true, 1, 1, [['s', '0', false], ['l', '400', false]])] })).toBeNull();
    // Two sides needed, one left on sale.
    expect(fromPrice({ basePrice: 800, optionGroups: [group('sides', true, 2, 3, [['a', '100'], ['b', '100', false]])] })).toBeNull();
    expect(requiredChoiceSoldOut({ basePrice: 800, optionGroups: [group('size', true, 1, 1, [['s', '0', false]])] })).toBe(true);
    // A sold-out OPTIONAL group never blocks the item.
    const optional = { basePrice: 800, optionGroups: [group('extras', false, 0, 2, [['x', '50', false]])] };
    expect(fromPrice(optional)).toBe(800);
    expect(requiredChoiceSoldOut(optional)).toBe(false);
    // Exactly enough on sale still has a From price.
    expect(fromPrice({ basePrice: 800, optionGroups: [group('sides', true, 2, 3, [['a', '100'], ['b', '150'], ['c', '50', false]])] })).toBe(1050);
  });

  it('the sheet’s price is the item plus each chosen choice of the item’s own groups', () => {
    const item = { basePrice: 1200, optionGroups: [group('size', true, 1, 1, [['l', '400']]), group('roti', true, 1, 1, [['d', '200']])] };
    expect(selectionPrice(item, { size: ['l'], roti: ['d'] })).toBe(1800);
    // An id that belongs to no group of this item is never priced.
    expect(selectionPrice(item, { size: ['l'], roti: ['not-this-item'] })).toBe(1600);
  });
});

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] Size sets the price, half-and-half, follow-up groups: the website's figures
// by the API's own rules, and the sheet's taps by the phone's own model (imported by path, never a copy).
// ---------------------------------------------------------------------------

describe('[MENU-OPTIONS] the website prices pizza-grade choices exactly as the server does', () => {
  const choice = (id: string, additionalPrice: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, additionalPrice, isAvailable: true, isDefault: false, sortOrder: 0, followUpGroupId: null as string | null, ...extra });
  const pizza = (halfPricePercent = 50) => ({
    basePrice: 1200,
    optionGroups: [
      { id: 'size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 0, setsPrice: true, options: [choice('personal', '1200'), choice('large', '3500', { sortOrder: 1 })] },
      { id: 'crust', name: 'Crust', isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 1, options: [choice('thin', '0'), choice('stuffed', '500', { sortOrder: 1, followUpGroupId: 'cheese' })] },
      { id: 'cheese', name: 'Cheese', isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 2, options: [choice('mozz', '0'), choice('cheddar', '100', { sortOrder: 1 })] },
      { id: 'toppings', name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 3, sortOrder: 3, allowHalves: true, halfPricePercent,
        options: [choice('pep', '300'), choice('mush', '175', { sortOrder: 1 }), choice('onion', '100', { sortOrder: 2 })] },
    ],
  });

  it('the chosen size IS the price (never item + size), extras on top; the same figure as the server’s cart line', () => {
    const sel = { size: ['large'], crust: ['thin'], toppings: ['onion'] };
    expect(selectionPrice(pizza(), sel)).toBe(3600);
    expect(selectionPrice(pizza(), { size: ['large'], crust: ['thin'] })).toBe(3500);
    const resolved = server.resolveSelectedOptions(pizza(), sel);
    expect(selectionPrice(pizza(), sel)).toBe(server.lineBasePrice(1200, resolved) + server.optionsUnitPrice(resolved));
  });

  it('halves at 50% (87.5 → 88) and at 100%', () => {
    expect(selectionPrice(pizza(), { size: ['personal'], crust: ['thin'], toppings: ['pep:left', 'mush:right', 'onion'] })).toBe(1200 + 150 + 88 + 100);
    expect(selectionPrice(pizza(100), { size: ['personal'], crust: ['thin'], toppings: ['pep:left'] })).toBe(1500);
  });

  it('a follow-up choice adds its price; without its opener the server’s validator refuses it', () => {
    expect(selectionPrice(pizza(), { size: ['large'], crust: ['stuffed'], cheese: ['cheddar'] })).toBe(3500 + 500 + 100);
    expect(selectionComplete(pizza(), { size: ['large'], crust: ['stuffed'] })).toBe(false);
    expect(selectionComplete(pizza(), { size: ['large'], crust: ['stuffed'], cheese: ['mozz'] })).toBe(true);
    expect(selectionComplete(pizza(), { size: ['large'], crust: ['thin'], cheese: ['mozz'] })).toBe(false);
  });

  it('From is the cheapest size on sale (not item + size), a follow-up group never adds to it, a half topping counts at its half price', () => {
    expect(fromPrice(pizza())).toBe(1200);
    const smallSoldOut = pizza();
    smallSoldOut.optionGroups[0]!.options[0]!.isAvailable = false;
    expect(fromPrice(smallSoldOut)).toBe(3500);
    const requiredTopping = pizza();
    Object.assign(requiredTopping.optionGroups[3]!, { isRequired: true, minSelect: 1 });
    expect(fromPrice(requiredTopping)).toBe(1200 + 50); // onion 100, on one half at 50%
    // A follow-up group whose every choice is sold out does not make the whole pizza sold out.
    const cheeseGone = pizza();
    for (const o of cheeseGone.optionGroups[2]!.options) o.isAvailable = false;
    expect(requiredChoiceSoldOut(cheeseGone)).toBe(false);
    expect(fromPrice(cheeseGone)).toBe(1200);
  });

  it('a sized, half-and-half or follow-up item opens its sheet instead of a one-tap add', () => {
    expect(needsChoices(pizza())).toBe(true);
    const onlyHalves = { basePrice: 800, optionGroups: [pizza().optionGroups[3]!] };
    expect(needsChoices(onlyHalves)).toBe(false);
    expect(opensChoices(onlyHalves)).toBe(true);
  });

  it('the basket keeps the server’s own display words for each choice', () => {
    expect(selectionNames(pizza(), { size: 'large', crust: 'stuffed', cheese: 'cheddar', toppings: ['pep:left'] }))
      .toEqual(['large', 'stuffed', 'cheddar', 'pep (left half)']); // the fixture names each choice by its id
  });

  it('the sheet’s taps are the phone’s own model, imported by path (never a copy)', () => {
    expect(chooseOption).toBe(phoneSheet.chooseOption);
    expect(defaultSelection).toBe(phoneSheet.defaultSelection);
    expect(orderLineChoices).toBe(phoneSheet.orderLineChoices);
    expect(halfPrice).toBe(server.halfPrice);
  });
});
