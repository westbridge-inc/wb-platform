import { describe, expect, it } from 'vitest';
import {
  attachPlan, choicePricePlaceholder, followUpLabel, followUpTargets, fromPriceWords, groupFlagsBody, groupRuleWords,
  halfRuleWords, isFollowUpGroup, libraryDeleteWords, libraryGroupsToAdd, lowestSizePrice, menuOptionsRefusal, moved,
  parseHalfPercent, sharedEditWarning, sharedUse, sizePriceLabel, usedByWords,
  PRICE_UNREADABLE, SIZE_PRICE_NEEDED, choicePriceInput, flagsOf, groupFlagsEdit, itemTypedPrice, libraryBasePrice,
  libraryChoiceDeleteWords, needsSizeSwitchConfirm, parseStorePrice, sizeSwitchBody, sizeSwitchRows, sizeSwitchShown, sizeSwitchTyped, sizeSwitchWords,
} from './menuOptionsEditor';

// [MENU-OPTIONS · owner 11 Nov 2026] The store tools' rules for pizza-grade options (size sets the price,
// half-and-half with the store's price rule, one level of follow-up groups, the shared option library). The server
// is the only judge (it refuses with MENU_OPTIONS_RULE); these rules only keep the store from offering a choice the
// server would refuse, and say things in the app's words. The website imports this file as is.

const money = (n: number) => `GYD ${n.toLocaleString('en-US')}`;

const size = { id: 'g-size', name: 'Size', setsPrice: true, isRequired: true, minSelect: 1, maxSelect: 1, options: [
  { id: 'o-s', name: 'Small', additionalPrice: 1800 }, { id: 'o-l', name: 'Large', additionalPrice: 3200 },
] };
const crust = { id: 'g-crust', name: 'Crust', isRequired: true, maxSelect: 1, options: [
  { id: 'o-thin', name: 'Thin', followUpGroupId: null }, { id: 'o-stuffed', name: 'Stuffed crust', followUpGroupId: 'g-cheese' },
] };
const cheese = { id: 'g-cheese', name: 'Cheese', options: [{ id: 'o-ched', name: 'Cheddar' }] };
const toppings = { id: 'g-top', name: 'Toppings', allowHalves: true, halfPricePercent: 50, maxSelect: 10, options: [{ id: 'o-pep', name: 'Pepperoni' }] };
const item = [size, crust, cheese, toppings];

describe('a group\'s rules as the store sets them', () => {
  it('"Sets the price" is always pick exactly one, and never half-and-half', () => {
    expect(groupFlagsBody({ required: false, multi: true, setsPrice: true, allowHalves: true, halfPercent: 50 }))
      .toEqual({ isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: true });
  });

  it('half-and-half sends the store\'s half price rule; a plain group sends exactly what it always sent', () => {
    expect(groupFlagsBody({ required: false, multi: true, setsPrice: false, allowHalves: true, halfPercent: 50 }))
      .toEqual({ isRequired: false, minSelect: 0, maxSelect: 10, allowHalves: true, halfPricePercent: 50 });
    expect(groupFlagsBody({ required: true, multi: false, setsPrice: false, allowHalves: false, halfPercent: 100 }))
      .toEqual({ isRequired: true, minSelect: 1, maxSelect: 1 });
  });

  it('an edit names every flag, so switching one off reaches the server', () => {
    expect(groupFlagsBody({ required: false, multi: true, setsPrice: false, allowHalves: false, halfPercent: 100 }, { explicit: true }))
      .toEqual({ isRequired: false, minSelect: 0, maxSelect: 10, setsPrice: false, allowHalves: false, halfPricePercent: 100 });
  });

  it('the half price rule: full price, or a whole percent from 1 to 100', () => {
    expect(halfRuleWords(100)).toBe('Full price');
    expect(halfRuleWords(50)).toBe('50% of the choice price');
    expect(parseHalfPercent('60')).toBe(60);
    expect(parseHalfPercent('0')).toBeNull();
    expect(parseHalfPercent('101')).toBeNull();
    expect(parseHalfPercent('12.5')).toBeNull();
    expect(parseHalfPercent('')).toBeNull();
  });

  it('the caption under a group says what the customer does', () => {
    expect(groupRuleWords(size)).toBe('Sets the price · pick one');
    expect(groupRuleWords(toppings)).toBe('Optional · up to 10 · Half-and-half (a half costs 50% of the choice price)');
    expect(groupRuleWords({ ...toppings, halfPricePercent: 100 })).toBe('Optional · up to 10 · Half-and-half (a half costs full price)');
    expect(groupRuleWords({ isRequired: true, maxSelect: 1 })).toBe('Required · pick one');
  });
});

describe('prices in a group that sets the price', () => {
  it('a size choice is the whole price ("Price"), not an extra ("+")', () => {
    expect(sizePriceLabel({ additionalPrice: 3200 }, money)).toBe('Price GYD 3,200');
    expect(sizePriceLabel({ additionalPrice: 3648, vatListedAdditionalPrice: 3200 }, money)).toBe('Price GYD 3,648 incl. VAT');
    expect(choicePricePlaceholder(true, false)).toBe('Price');
    expect(choicePricePlaceholder(true, true)).toBe('Price before VAT');
    expect(choicePricePlaceholder(false, false)).toBe('+GYD');
    expect(choicePricePlaceholder(false, true)).toBe('+GYD before VAT');
  });

  it('the item\'s own price is the lowest size (what the store typed), read-only', () => {
    expect(lowestSizePrice(item)).toBe(1800);
    expect(lowestSizePrice([{ ...size, options: [{ id: 'a', name: 'A', additionalPrice: 2280, vatListedAdditionalPrice: 2000 }, { id: 'b', name: 'B', additionalPrice: 2400 }] }])).toBe(2000);
    expect(lowestSizePrice([crust, toppings])).toBeNull();
    expect(lowestSizePrice([{ ...size, options: [] }])).toBeNull();
    expect(fromPriceWords(1800, money)).toBe('From GYD 1,800 (lowest size)');
  });
});

describe('follow-up groups, one level deep', () => {
  it('a choice may open another group of the item: never its own, never the size, never one that opens others', () => {
    expect(followUpTargets(item, 'g-crust').map((g) => g.id)).toEqual(['g-cheese', 'g-top']);
    expect(followUpTargets(item, 'g-size').map((g) => g.id)).toEqual(['g-cheese', 'g-top']);
  });

  it('a follow-up group\'s own choices open nothing (one level only)', () => {
    expect(isFollowUpGroup(item, 'g-cheese')).toBe(true);
    expect(isFollowUpGroup(item, 'g-crust')).toBe(false);
    expect(followUpTargets(item, 'g-cheese')).toEqual([]);
  });

  it('the picker\'s label names the group a choice opens', () => {
    expect(followUpLabel(item, 'g-cheese')).toBe('Opens: Cheese');
    expect(followUpLabel(item, null)).toBe('Opens follow-up group');
    expect(followUpLabel(item, 'gone')).toBe('Opens follow-up group');
  });
});

describe('the shared option library', () => {
  const library = [
    { id: 'lib-size', name: 'Pizza size', usedByItemCount: 4, isFollowUp: false },
    { id: 'lib-sauce', name: 'Sauce', usedByItemCount: 2, isFollowUp: true },
    { id: 'lib-dips', name: 'Dips', usedByItemCount: 0, isFollowUp: false },
  ];

  it('an item\'s copy of a shared group says how many items use it, and edits warn they apply to all', () => {
    expect(sharedUse({ libraryGroupId: 'lib-size' }, library)).toEqual({ libraryGroupId: 'lib-size', usedBy: 4 });
    expect(sharedUse({ libraryGroupId: null }, library)).toBeNull();
    expect(sharedUse({ libraryGroupId: 'lib-unknown' }, library)).toEqual({ libraryGroupId: 'lib-unknown', usedBy: 1 });
    expect(usedByWords(4)).toBe('Used by 4 items');
    expect(usedByWords(1)).toBe('Used by 1 item');
    expect(sharedEditWarning(4)).toBe('Changes apply to all 4 items');
    expect(sharedEditWarning(1)).toBe('Changes apply to the 1 item that uses it');
  });

  it('"Add from option library" offers the groups not on the item yet (a follow-up comes with its opener)', () => {
    expect(libraryGroupsToAdd(library, [{ libraryGroupId: 'lib-size' }, { libraryGroupId: null }]).map((g) => g.id)).toEqual(['lib-dips']);
  });

  it('bulk attach / detach sends only the change', () => {
    expect(attachPlan(['a', 'b'], ['b', 'c'])).toEqual({ attach: ['c'], detach: ['a'] });
    expect(attachPlan(['a'], ['a'])).toEqual({ attach: [], detach: [] });
  });

  it('delete says how many items lose the group', () => {
    expect(libraryDeleteWords(3)).toBe('It is removed from 3 items that use it.');
    expect(libraryDeleteWords(1)).toBe('It is removed from 1 item that uses it.');
    expect(libraryDeleteWords(0)).toBe('No item uses it.');
  });

  it('reorder moves one group up or down, never past the ends', () => {
    expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('the server\'s refusal, shown in its own words', () => {
  it('a broken option rule or an edit of a shared copy: the server\'s message (phone and website error shapes)', () => {
    const phone = { response: { data: { error: { code: 'MENU_OPTIONS_RULE', message: '"Cheddar" is a follow-up choice, so it cannot open another group (one level only).' } } } };
    expect(menuOptionsRefusal(phone)).toBe('"Cheddar" is a follow-up choice, so it cannot open another group (one level only).');
    expect(menuOptionsRefusal({ code: 'SHARED_OPTION_GROUP', message: 'Edit it in the option library.' })).toBe('Edit it in the option library.');
  });

  it('anything else is not this rule\'s to word', () => {
    expect(menuOptionsRefusal({ response: { data: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } } })).toBeNull();
    expect(menuOptionsRefusal(new Error('Network Error'))).toBeNull();
    expect(menuOptionsRefusal(null)).toBeNull();
  });
});

// ── [REVIEW-MENU-B S3-3] One price parser for the store tools ───────────────
describe('a typed price', () => {
  it('reads what a store types on any keyboard: "1,500", "1500.00", "$1,500", " 2000 "', () => {
    expect(parseStorePrice('1,500')).toBe(1500);
    expect(parseStorePrice('1500.00')).toBe(1500);
    expect(parseStorePrice('$1,500')).toBe(1500);
    expect(parseStorePrice(' 2000 ')).toBe(2000);
    expect(parseStorePrice('0')).toBe(0);
    expect(parseStorePrice('1 500')).toBe(1500);
  });

  it('never turns a blank, a mistype, a negative or cents into a price', () => {
    for (const text of ['', '   ', 'abc', '1.500,00', '-200', '15OO', '1500.5', '1,50', '1,5000', '12-3']) {
      expect(parseStorePrice(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('a choice\'s price: a size needs a price above 0; an add-on left blank is free, a mistyped one is refused', () => {
    expect(choicePriceInput('1,500', { size: true })).toEqual({ price: 1500 });
    expect(choicePriceInput('', { size: true })).toEqual({ problem: SIZE_PRICE_NEEDED });
    expect(choicePriceInput('0', { size: true })).toEqual({ problem: SIZE_PRICE_NEEDED });
    expect(choicePriceInput('0', { size: false })).toEqual({ price: 0 });
    expect(choicePriceInput('', { size: false })).toEqual({ price: 0 });
    expect(choicePriceInput('1,5', { size: false })).toEqual({ problem: PRICE_UNREADABLE });
    expect(choicePriceInput('12a', { size: false })).toEqual({ problem: PRICE_UNREADABLE });
  });
});

// ── [REVIEW-MENU-B S2-1] Switching "Sets the price" converts the prices, shown first ──
describe('switching "Sets the price" on a group that already has choices', () => {
  const addOns = [{ id: 'o-s', name: 'Small', additionalPrice: 0 }, { id: 'o-l', name: 'Large', additionalPrice: 500 }];

  it('ON: each size\'s full price is the item\'s price plus its add-on', () => {
    expect(sizeSwitchRows(addOns, { turnOn: true, itemPrice: 2000 })).toEqual([
      { id: 'o-s', name: 'Small', price: 2000 }, { id: 'o-l', name: 'Large', price: 2500 },
    ]);
  });

  it('OFF: each add-on is its price above the smallest size (the item keeps the smallest as its price)', () => {
    const sizes = [{ id: 'o-s', name: 'Small', additionalPrice: 2000 }, { id: 'o-l', name: 'Large', additionalPrice: 2500, vatListedAdditionalPrice: 2500 }];
    expect(sizeSwitchRows(sizes, { turnOn: false, itemPrice: 2000 })).toEqual([
      { id: 'o-s', name: 'Small', price: 0 }, { id: 'o-l', name: 'Large', price: 500 },
    ]);
  });

  it('uses what the store TYPED (before VAT), for the item and each choice', () => {
    const vat = [{ id: 'o-l', name: 'Large', additionalPrice: 570, vatListedAdditionalPrice: 500 }];
    expect(sizeSwitchRows(vat, { turnOn: true, itemPrice: 2000 })).toEqual([{ id: 'o-l', name: 'Large', price: 2500 }]);
    expect(itemTypedPrice({ basePrice: 2280, vatListedPrice: 2000 })).toBe(2000);
    expect(itemTypedPrice({ basePrice: '1500' })).toBe(1500);
  });

  it('a shared group: the items can differ, so the sizes start from the lowest item price that uses it (none known: null)', () => {
    expect(libraryBasePrice([{ basePrice: 2500 }, { basePrice: 1800, vatListedPrice: 1800 }, { basePrice: 'x' }])).toBe(1800);
    expect(libraryBasePrice([])).toBeNull();
    expect(libraryBasePrice([{ id: 'i' } as { basePrice?: unknown }])).toBeNull();
  });

  it('an item price not known: each size starts blank for the store to type (never the add-on alone as a whole price)', () => {
    const rows = sizeSwitchRows(addOns, { turnOn: true, itemPrice: null });
    expect(rows).toEqual([{ id: 'o-s', name: 'Small', price: null }, { id: 'o-l', name: 'Large', price: null }]);
    expect(sizeSwitchTyped(rows)).toEqual({ 'o-s': '', 'o-l': '' });
    expect(sizeSwitchWords(sizeSwitchShown(addOns, { 'o-s': '', 'o-l': '2,600' }), { turnOn: true }, money))
      .toBe('Small (type its price) / Large GYD 2,600 — the item’s price becomes its sizes’ prices.');
    expect(itemTypedPrice({})).toBeNull();
    expect(itemTypedPrice({ basePrice: '' })).toBeNull();
  });

  it('the confirm says what happens, in the app\'s words', () => {
    const rows = [{ id: 'o-s', name: 'Small', price: 2000 }, { id: 'o-l', name: 'Large', price: 2500 }];
    expect(sizeSwitchWords(rows, { turnOn: true }, money)).toBe('Small GYD 2,000 / Large GYD 2,500 — the item’s price becomes its sizes’ prices.');
    expect(sizeSwitchWords([{ id: 'o-s', name: 'Small', price: 0 }, { id: 'o-l', name: 'Large', price: 500 }], { turnOn: false }, money))
      .toBe('Small +GYD 0 / Large +GYD 500 — the item keeps its smallest size as its price; these are added on top.');
    expect(sizeSwitchWords(rows, { turnOn: true, sharedBy: 3 }, money)).toBe('Small GYD 2,000 / Large GYD 2,500 — every item that uses this group (3 items) costs these sizes’ prices.');
  });

  it('the request: the switch and every choice\'s new price in one, each typed price read like any other (a size above 0)', () => {
    const typed = { 'o-s': '2,000', 'o-l': '2500' };
    expect(sizeSwitchBody(addOns, typed, { turnOn: true })).toEqual({ body: { setsPrice: true, prices: [{ id: 'o-s', price: 2000 }, { id: 'o-l', price: 2500 }] } });
    expect(sizeSwitchBody(addOns, { 'o-s': '', 'o-l': '2500' }, { turnOn: true })).toEqual({ problem: `Small: ${SIZE_PRICE_NEEDED}` });
    expect(sizeSwitchBody(addOns, { 'o-s': '0', 'o-l': '500' }, { turnOn: false })).toEqual({ body: { setsPrice: false, prices: [{ id: 'o-s', price: 0 }, { id: 'o-l', price: 500 }] } });
    expect(sizeSwitchBody(addOns, { 'o-s': '0', 'o-l': '5OO' }, { turnOn: false })).toEqual({ problem: `Large: ${PRICE_UNREADABLE}` });
  });

  it('[DELTA S4-b] a half-and-half group made a size turns its halves off in the same request', () => {
    expect(sizeSwitchBody(addOns, { 'o-s': '2000', 'o-l': '2500' }, { turnOn: true, halves: true }))
      .toEqual({ body: { setsPrice: true, allowHalves: false, prices: [{ id: 'o-s', price: 2000 }, { id: 'o-l', price: 2500 }] } });
    expect(sizeSwitchBody(addOns, { 'o-s': '0', 'o-l': '500' }, { turnOn: false, halves: true })).toEqual({ body: { setsPrice: false, prices: [{ id: 'o-s', price: 0 }, { id: 'o-l', price: 500 }] } });
  });

  it('[DELTA S2-N1] OFF converts against the lowest of ALL sizes, a sold-out one included (the server keeps that size as the item price)', () => {
    const sizes = [{ id: 'o-s', name: 'Small', additionalPrice: 1200, isAvailable: false }, { id: 'o-l', name: 'Large', additionalPrice: 2400, isAvailable: true }];
    expect(sizeSwitchRows(sizes, { turnOn: false, itemPrice: 2400 })).toEqual([{ id: 'o-s', name: 'Small', price: 0 }, { id: 'o-l', name: 'Large', price: 1200 }]);
    expect(sizeSwitchWords(sizeSwitchRows(sizes, { turnOn: false, itemPrice: 2400 }), { turnOn: false }, money))
      .toBe('Small +GYD 0 / Large +GYD 1,200 — the item keeps its smallest size as its price; these are added on top.');
  });

  it('a switch needs the confirm only when the group has choices', () => {
    expect(needsSizeSwitchConfirm({ setsPrice: false, options: addOns }, { setsPrice: true })).toBe(true);
    expect(needsSizeSwitchConfirm({ setsPrice: true, options: addOns }, { setsPrice: false })).toBe(true);
    expect(needsSizeSwitchConfirm({ setsPrice: false, options: [] }, { setsPrice: true })).toBe(false);
    expect(needsSizeSwitchConfirm({ setsPrice: false, options: addOns }, { allowHalves: true })).toBe(false);
  });
});

// ── [REVIEW-MENU-B S3-2] A rule chip sends only the rule that changed ───────
describe('an edit of a saved group sends only what changed', () => {
  const custom = { isRequired: true, minSelect: 2, maxSelect: 3, setsPrice: false, allowHalves: false, halfPricePercent: 100 };

  it('half-and-half on a group with its own limits keeps them (no minSelect / maxSelect / isRequired)', () => {
    expect(groupFlagsEdit(custom, { ...flagsOf(custom), allowHalves: true })).toEqual({ allowHalves: true });
    expect(groupFlagsEdit({ ...custom, allowHalves: true }, { ...flagsOf({ ...custom, allowHalves: true }), halfPercent: 60 })).toEqual({ halfPricePercent: 60 });
  });

  it('"Sets the price" sends the switch alone (the server makes a size pick-one), and turns half-and-half off with it', () => {
    expect(groupFlagsEdit(custom, { ...flagsOf(custom), setsPrice: true })).toEqual({ setsPrice: true });
    expect(groupFlagsEdit({ ...custom, allowHalves: true }, { ...flagsOf({ ...custom, allowHalves: true }), setsPrice: true, allowHalves: false })).toEqual({ setsPrice: true, allowHalves: false });
  });

  it('Required / Multiple picks change the limits only when the store taps them', () => {
    expect(groupFlagsEdit(custom, { ...flagsOf(custom), required: false })).toEqual({ isRequired: false, minSelect: 0 });
    expect(groupFlagsEdit({ ...custom, isRequired: false, minSelect: 0, maxSelect: 1 }, { ...flagsOf({ ...custom, isRequired: false, minSelect: 0, maxSelect: 1 }), required: true }))
      .toEqual({ isRequired: true, minSelect: 1 });
    expect(groupFlagsEdit(custom, { ...flagsOf(custom), multi: false })).toEqual({ maxSelect: 1, minSelect: 1 });
    expect(groupFlagsEdit(custom, flagsOf(custom))).toEqual({});
  });
});

describe('an older app is told to update, in the server\'s words', () => {
  it('409 APP_UPDATE_REQUIRED is the server\'s own sentence too', () => {
    const words = 'This group uses sizes, half-and-half or follow-up choices. Update the Swift app to change it.';
    expect(menuOptionsRefusal({ response: { data: { error: { code: 'APP_UPDATE_REQUIRED', message: words } } } })).toBe(words);
  });
});

describe('deleting a shared choice asks first', () => {
  it('names the choice and how many items lose it', () => {
    expect(libraryChoiceDeleteWords('Pepperoni', 3)).toEqual({ title: 'Remove “Pepperoni”?', body: 'It is removed from 3 items that use this group.' });
    expect(libraryChoiceDeleteWords('Pepperoni', 1).body).toBe('It is removed from the 1 item that uses this group.');
    expect(libraryChoiceDeleteWords('Pepperoni', 0).body).toBe('No item uses this group yet.');
  });
});
