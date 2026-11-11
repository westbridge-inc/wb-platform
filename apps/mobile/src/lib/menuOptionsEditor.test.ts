import { describe, expect, it } from 'vitest';
import {
  attachPlan, choicePricePlaceholder, followUpLabel, followUpTargets, fromPriceWords, groupFlagsBody, groupRuleWords,
  halfRuleWords, isFollowUpGroup, libraryDeleteWords, libraryGroupsToAdd, lowestSizePrice, menuOptionsRefusal, moved,
  parseHalfPercent, sharedEditWarning, sharedUse, sizePriceLabel, usedByWords,
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
