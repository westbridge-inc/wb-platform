import { describe, expect, it } from 'vitest';
import {
  itemGoneWords, orderReadyEstimate, promisedTimeName, ratingTagFitsStore, readyTimeLabel, searchItemsHeading, storeKindWords, tooBusyReason,
  workingOrderWord,
} from './storeKindWords';

// [STORE-WORDS · owner 9 Nov 2026] A store's words follow its kind. Only a restaurant speaks of onions,
// prep and a menu; a kind this build does not know gets neutral words, never a kitchen's.

const KITCHEN = /onion|pepper|\bprep\b|\bmenu\b|kitchen|\bmeal|\bdish|cook|dining/i;

describe('storeKindWords', () => {
  it('a restaurant keeps its exact words', () => {
    expect(storeKindWords('RESTAURANT')).toEqual({
      itemNotePlaceholder: 'e.g. no onions, extra pepper',
      catalogue: 'the menu',
      itemGoneTitle: 'This item is no longer on the menu.',
      itemGoneBody: 'The store took it off. Pick something else from its menu.',
      qrWelcome: 'Dining in? Browse our menu here and place your order with your server.',
      allItemsChip: 'Full menu',
    });
  });

  it('[sweep] the "every section" chip: "Full menu" only for a restaurant', () => {
    for (const kind of ['SUPERMARKET', 'STORE', 'SERVICE', 'SOMETHING_NEW', undefined]) {
      expect(storeKindWords(kind).allItemsChip, String(kind)).toBe('All');
    }
  });

  it('[sweep · review note 2] a service business reads "services", never "list", and books at the counter', () => {
    const words = storeKindWords('SERVICE');
    expect(words.catalogue).toBe('the services');
    expect(words.itemGoneBody).toBe('The business took it off. Pick something else from its services.');
    expect(words.qrWelcome).toBe('Here in person? Browse what this business offers and book at the counter.');
    expect(Object.values(words).join(' | ')).not.toMatch(/\blist\b|sells/);
  });

  it('each store kind gets its own note hint', () => {
    expect(storeKindWords('SUPERMARKET').itemNotePlaceholder).toBe('e.g. ripe ones, no substitutes');
    expect(storeKindWords('STORE').itemNotePlaceholder).toBe('e.g. size, colour, gift wrap');
    expect(storeKindWords('SERVICE').itemNotePlaceholder).toBe('e.g. what you need, and anything that helps');
  });

  it('no store other than a restaurant is ever handed a kitchen word, unknown and missing kinds included', () => {
    for (const kind of ['SUPERMARKET', 'STORE', 'SERVICE', 'SOMETHING_NEW', null, undefined, '']) {
      const words = Object.values(storeKindWords(kind)).join(' | ');
      expect(words, String(kind)).not.toMatch(KITCHEN);
    }
  });

  it('a kind this build does not know: the neutral hint', () => {
    expect(storeKindWords(undefined).itemNotePlaceholder).toBe('Anything the store should know');
    expect(storeKindWords('SOMETHING_NEW').itemNotePlaceholder).toBe('Anything the store should know');
    expect(storeKindWords('toString').itemNotePlaceholder).toBe('Anything the store should know');
  });
});

describe('readyTimeLabel / orderReadyEstimate', () => {
  it('a restaurant: "N min prep" and "About N min prep", unchanged', () => {
    expect(readyTimeLabel('RESTAURANT', 30)).toBe('30 min prep');
    expect(orderReadyEstimate('RESTAURANT', 20)).toBe('About 20 min prep');
  });

  it('any other store: "Ready in about N min"', () => {
    for (const kind of ['SUPERMARKET', 'STORE', 'SERVICE', undefined, null]) {
      expect(readyTimeLabel(kind, 30)).toBe('Ready in about 30 min');
      expect(orderReadyEstimate(kind, 30)).toBe('Ready in about 30 min');
    }
  });

  it('no time is no line: never an invented number', () => {
    for (const minutes of [undefined, null, 0, -5, Number.NaN, '30']) {
      expect(readyTimeLabel('STORE', minutes)).toBeNull();
      expect(readyTimeLabel('RESTAURANT', minutes)).toBeNull();
      expect(orderReadyEstimate('RESTAURANT', minutes)).toBeNull();
    }
    expect(readyTimeLabel('STORE', 12.6)).toBe('Ready in about 13 min');
  });
});

describe('ratingTagFitsStore', () => {
  it('a shop and a service business are never offered the food-only tags', () => {
    for (const kind of ['STORE', 'SERVICE']) {
      expect(ratingTagFitsStore('tasty-food', kind)).toBe(false);
      expect(ratingTagFitsStore('cold-food', kind)).toBe(false);
      expect(ratingTagFitsStore('missing-items', kind)).toBe(true);
    }
  });

  it('a restaurant, a supermarket and an unknown kind keep every tag', () => {
    for (const kind of ['RESTAURANT', 'SUPERMARKET', undefined, null]) {
      expect(ratingTagFitsStore('tasty-food', kind)).toBe(true);
      expect(ratingTagFitsStore('cold-food', kind)).toBe(true);
    }
  });
});

describe('searchItemsHeading', () => {
  it('"Dishes" only for a restaurant search', () => {
    expect(searchItemsHeading('RESTAURANT')).toBe('Dishes');
    expect(searchItemsHeading('SUPERMARKET')).toBe('Products');
    expect(searchItemsHeading(undefined)).toBe('Dishes and products');
    expect(searchItemsHeading('STORE')).toBe('Dishes and products');
  });
});

describe('[sweep] itemGoneWords', () => {
  it('a restaurant keeps its sentence; any other store reads its own word for its items', () => {
    expect(itemGoneWords('RESTAURANT')).toBe('This section or item was removed on another phone. Go back and open the menu again.');
    expect(itemGoneWords('SUPERMARKET')).toBe('This section or item was removed on another phone. Go back and open the catalogue again.');
    for (const kind of ['STORE', 'SERVICE', undefined]) expect(itemGoneWords(kind)).not.toMatch(KITCHEN);
  });
});

describe('[sweep] the store\'s own order words', () => {
  it('a restaurant keeps its kitchen words exactly', () => {
    expect(tooBusyReason('RESTAURANT')).toBe('Kitchen is too busy');
    expect(promisedTimeName('RESTAURANT')).toBe('prep time');
    expect(workingOrderWord('RESTAURANT')).toBe('cooking');
  });

  it('any other store (unknown and missing kinds included) gets counter words', () => {
    for (const kind of ['SUPERMARKET', 'STORE', 'SERVICE', 'SOMETHING_NEW', null, undefined]) {
      expect(tooBusyReason(kind), String(kind)).toBe('Too busy right now');
      expect(promisedTimeName(kind), String(kind)).toBe('ready time');
      expect(workingOrderWord(kind), String(kind)).toBe('being prepared');
      expect([tooBusyReason(kind), promisedTimeName(kind), workingOrderWord(kind)].join(' ')).not.toMatch(KITCHEN);
    }
  });
});
