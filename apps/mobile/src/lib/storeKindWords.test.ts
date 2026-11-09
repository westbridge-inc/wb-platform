import { describe, expect, it } from 'vitest';
import { orderReadyEstimate, ratingTagFitsStore, readyTimeLabel, searchItemsHeading, storeKindWords } from './storeKindWords';

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
    });
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
