import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as server from '../../../api/src/modules/order/options';
import * as phone from './menuOptionsEngine';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] The phone's copy of the server's option rules says exactly what the server
// says: the same numbers the API's own tests pin (apps/api/src/__tests__/menu-options-pricing.unit.test.ts), and
// the same answer as the API module itself on every menu and selection below. Synthetic menu only.
// ---------------------------------------------------------------------------

const opt = (id: string, name: string, price: number, extra: Partial<{ followUpGroupId: string | null; isAvailable: boolean; sortOrder: number }> = {}) =>
  ({ id, name, additionalPrice: price, isAvailable: extra.isAvailable ?? true, followUpGroupId: extra.followUpGroupId ?? null, sortOrder: extra.sortOrder ?? 0 });

type Opt = ReturnType<typeof opt>;
type Extra = Partial<{ isRequired: boolean; minSelect: number; maxSelect: number; sortOrder: number; setsPrice: boolean; allowHalves: boolean; halfPricePercent: number }>;
const group = (id: string, name: string, options: Opt[], extra: Extra = {}) => ({
  id, name, options,
  isRequired: extra.isRequired ?? false, minSelect: extra.minSelect ?? 0, maxSelect: extra.maxSelect ?? 1,
  sortOrder: extra.sortOrder ?? 0, setsPrice: extra.setsPrice ?? false, allowHalves: extra.allowHalves ?? false,
  halfPricePercent: extra.halfPricePercent ?? 100,
});

/** The API tests' pizza: Size sets the price, Crust (Stuffed opens Cheese), Toppings half-and-half. */
function pizza(o: { halfPricePercent?: number; mushroomAvailable?: boolean } = {}) {
  return {
    basePrice: 1200,
    optionGroups: [
      group('size', 'Size', [opt('personal', 'Personal', 1200), opt('medium', 'Medium', 2500, { sortOrder: 1 }), opt('large', 'Large', 3500, { sortOrder: 2 })],
        { setsPrice: true, isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 0 }),
      group('crust', 'Crust', [opt('thin', 'Thin', 0), opt('stuffed', 'Stuffed crust', 500, { followUpGroupId: 'cheese', sortOrder: 1 })],
        { isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 1 }),
      group('cheese', 'Cheese', [opt('mozz', 'Mozzarella', 0), opt('cheddar', 'Cheddar', 100, { sortOrder: 1 })],
        { isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 2 }),
      group('toppings', 'Toppings', [
        opt('pep', 'Pepperoni', 300), opt('mush', 'Mushroom', 175, { sortOrder: 1, isAvailable: o.mushroomAvailable ?? true }), opt('onion', 'Onion', 100, { sortOrder: 2 }),
      ], { allowHalves: true, halfPricePercent: o.halfPricePercent ?? 50, maxSelect: 3, sortOrder: 3 }),
    ],
  };
}

type Engine = typeof phone;
const unit = (engine: Pick<Engine, 'resolveSelectedOptions' | 'lineBasePrice' | 'optionsUnitPrice'>, item: ReturnType<typeof pizza>, sel: unknown) => {
  const options = engine.resolveSelectedOptions(item, sel);
  return engine.lineBasePrice(item.basePrice, options) + engine.optionsUnitPrice(options);
};
const verdict = (engine: Pick<Engine, 'validateSelectedOptions'>, item: ReturnType<typeof pizza>, sel: unknown) => {
  try { return { ok: engine.validateSelectedOptions(item, sel) }; } catch (e) { return { reason: (e as { reason?: string }).reason, message: (e as Error).message }; }
};

describe('[MENU-OPTIONS] the phone prices like the server (the API tests’ numbers)', () => {
  it('size sets the price: the chosen size IS the unit price, extras on top', () => {
    expect(unit(phone, pizza(), { size: 'large', crust: 'thin', toppings: ['onion'] })).toBe(3600);
    expect(unit(phone, pizza(), { size: 'medium', crust: 'thin' })).toBe(2500);
  });

  it('halves at 50%: 1200 + 300×50% + 175×50% (87.5 → 88) + 100 whole', () => {
    expect(unit(phone, pizza(), { size: 'personal', crust: 'thin', toppings: ['pep:left', 'mush:right', 'onion'] })).toBe(1200 + 150 + 88 + 100);
  });

  it('halves at 100%: a half costs the full price', () => {
    expect(unit(phone, pizza({ halfPricePercent: 100 }), { size: 'personal', crust: 'thin', toppings: ['pep:left'] })).toBe(1500);
    expect(unit(phone, pizza(), { size: 'large', crust: 'thin', toppings: ['pep:left'] })).toBe(3650);
  });

  it('halfPrice rounds half-up to the whole dollar exactly, keeps cents at 100%, never free', () => {
    expect(phone.halfPrice(175, 50)).toBe(88);
    expect(phone.halfPrice(301, 50)).toBe(151);
    expect(phone.halfPrice(300, 33)).toBe(99);
    expect(phone.halfPrice(175.5, 100)).toBe(175.5);
    expect(phone.halfPrice(200, 0)).toBe(200);
  });

  it('a follow-up choice adds its price under its opener', () => {
    expect(unit(phone, pizza(), { size: 'medium', crust: 'stuffed', cheese: 'cheddar' })).toBe(2500 + 500 + 100);
    expect(phone.resolveSelectedOptions(pizza(), { size: 'medium', crust: 'stuffed', cheese: 'cheddar' }).map((o) => o.optionGroupName))
      .toEqual(['Size', 'Crust', 'Cheese (Stuffed crust)']);
  });

  it('refuses what the server refuses, for the same reason', () => {
    expect(verdict(phone, pizza(), { size: 'medium', crust: 'stuffed' })).toMatchObject({ reason: 'OPTION_REQUIRED' });
    expect(verdict(phone, pizza(), { size: 'medium', crust: 'thin', cheese: 'cheddar' })).toMatchObject({ reason: 'OPTION_FOLLOW_UP' });
    expect(verdict(phone, pizza(), { size: ['large', 'medium'], crust: 'thin' })).toMatchObject({ reason: 'OPTION_LIMIT' });
    expect(verdict(phone, pizza(), { size: 'large:left', crust: 'thin' })).toMatchObject({ reason: 'OPTION_PLACEMENT' });
    expect(verdict(phone, pizza({ mushroomAvailable: false }), { size: 'large', crust: 'thin', toppings: ['mush:left'] })).toMatchObject({ reason: 'OPTION_UNAVAILABLE' });
    expect(verdict(phone, pizza(), { crust: 'thin' })).toMatchObject({ reason: 'OPTION_REQUIRED' });
  });
});

describe('[MENU-OPTIONS] the phone’s copy and the API module agree on every selection', () => {
  const choices: Record<string, string[]> = {
    size: ['personal', 'medium', 'large', 'large:left', 'ghost'],
    crust: ['thin', 'stuffed', 'thin:right'],
    cheese: ['mozz', 'cheddar'],
    toppings: ['pep', 'pep:left', 'pep:right', 'mush', 'mush:left', 'onion:right', 'onion', 'pep:free'],
  };
  // Every size × crust × cheese (or none) × up to two toppings: a few thousand selections, each judged and priced
  // by both modules.
  const selections: Array<Record<string, unknown>> = [];
  const toppingSets: string[][] = [[]];
  for (const a of choices['toppings']!) { toppingSets.push([a]); for (const b of choices['toppings']!) if (a < b) toppingSets.push([a, b]); }
  for (const size of [undefined, ...choices['size']!]) for (const crust of [undefined, ...choices['crust']!])
    for (const cheese of [undefined, ...choices['cheese']!]) for (const toppings of toppingSets) {
      const sel: Record<string, unknown> = {};
      if (size) sel['size'] = size;
      if (crust) sel['crust'] = crust;
      if (cheese) sel['cheese'] = cheese;
      if (toppings.length) sel['toppings'] = toppings;
      selections.push(sel);
    }

  it.each([
    ['50%', pizza()],
    ['33%', pizza({ halfPricePercent: 33 })],
    ['100%', pizza({ halfPricePercent: 100 })],
    ['a sold-out topping', pizza({ mushroomAvailable: false })],
  ])('pizza with halves at %s', (_label, item) => {
    expect(selections.length).toBeGreaterThan(1000);
    for (const sel of selections) {
      expect(verdict(phone, item, sel), JSON.stringify(sel)).toEqual(verdict(server, item, sel));
      expect(unit(phone, item, sel), JSON.stringify(sel)).toBe(unit(server, item, sel));
      expect(phone.resolveSelectedOptions(item, sel)).toEqual(server.resolveSelectedOptions(item, sel));
    }
  });

  it('halfPrice agrees on every percent and a spread of prices (cents included)', () => {
    for (let pct = 0; pct <= 101; pct++) for (const price of [0, 1, 99, 100, 175, 175.5, 301, 999.99, 12345, 99999999]) {
      expect(phone.halfPrice(price, pct), `${price} @ ${pct}%`).toBe(server.halfPrice(price, pct));
    }
  });

  it('below its header the phone’s file IS the API file, character for character (copy every change across)', () => {
    const body = (path: string) => { const code = readFileSync(path, 'utf8'); return code.slice(code.indexOf('export type Placement')); };
    expect(body(join(__dirname, 'menuOptionsEngine.ts'))).toBe(body(join(__dirname, '../../../api/src/modules/order/options.ts')));
  });

  it('the capability word is the server’s', () => {
    expect(phone.MENU_OPTIONS_CAPABILITY).toBe(server.MENU_OPTIONS_CAPABILITY);
  });
});
