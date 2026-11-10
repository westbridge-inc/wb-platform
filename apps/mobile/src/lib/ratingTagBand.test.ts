import { describe, expect, it } from 'vitest';
import { ratingBand, tagsOnScreen } from './ratingTagBand';
import { ratingTagFitsStore } from './storeKindWords';

// [RATINGS · owner report 10 Nov 2026] The band split is the server's (tagsForRole: 3 stars and under
// is NEGATIVE), and what is sent is only what the stars show — see FeedbackScreen.tagBand.navigation.test.ts.
const VENDOR = {
  positive: [{ slug: 'great-value' }, { slug: 'tasty-food' }],
  negative: [{ slug: 'missing-items' }, { slug: 'cold-food' }],
};

describe('ratingBand', () => {
  it('splits where the server does: 1–3 is "What went wrong?", 4–5 is "What was great?"', () => {
    expect([1, 2, 3, 4, 5].map(ratingBand)).toEqual(['negative', 'negative', 'negative', 'positive', 'positive']);
  });
});

describe('tagsOnScreen', () => {
  it('keeps only the picked tags in the band the stars show', () => {
    expect(tagsOnScreen(['great-value', 'missing-items'], 2, VENDOR)).toEqual(['missing-items']);
    expect(tagsOnScreen(['great-value', 'missing-items'], 5, VENDOR)).toEqual(['great-value']);
  });

  it('drops a tag that does not fit the store, even in the right band', () => {
    const shop = (slug: string) => ratingTagFitsStore(slug, 'STORE');
    expect(tagsOnScreen(['tasty-food', 'great-value'], 5, VENDOR, shop)).toEqual(['great-value']);
    expect(tagsOnScreen(['cold-food'], 1, VENDOR, shop)).toEqual([]);
  });

  it('sends nothing with no stars or no chip sets', () => {
    expect(tagsOnScreen(['great-value'], 0, VENDOR)).toEqual([]);
    expect(tagsOnScreen(['great-value'], 5, undefined)).toEqual([]);
  });
});
