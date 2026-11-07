import { describe, expect, it } from 'vitest';
import { ownNameOfferFits, ownNameSigningFor } from './ownNameCopy';

// [ROLE-DOCS · REVIEW-F #2046 S4-1] The declaration is PER STORE: the card names the store it is signed for, so an
// owner with two stores sees which one they sign for. No name, no line (never a blank "for").
describe('[ROLE-DOCS] the own-name card names the store it signs for', () => {
  it('names the store, trimmed and quoted', () => {
    expect(ownNameSigningFor('  R. Persaud ')).toBe('You sign this for “R. Persaud” only.');
  });
  it('says nothing when there is no name yet', () => {
    for (const blank of [undefined, null, '', '   ']) expect(ownNameSigningFor(blank)).toBeNull();
  });
});

// [OWNNAME-FIT · COORD ruling 7 Nov 2026, Cap. 90:05 s.3] The own-name route is OFFERED only for a store whose name the
// server says passes its own-name test (GET /verification/status `ownNameFits`, per store).
describe('[OWNNAME-FIT] the own-name offer follows the server\'s answer for the selected store', () => {
  it('offers it only when the server says this store\'s name fits', () => {
    const status = { ownNameFits: { persaud: true, westbridge: false } };
    expect(ownNameOfferFits(status, 'persaud')).toBe(true);
    expect(ownNameOfferFits(status, 'westbridge')).toBe(false);
    // a store the answer does not name
    expect(ownNameOfferFits(status, 'other')).toBe(false);
  });
  it('an older server (no field), no store or an odd answer: no offer', () => {
    expect(ownNameOfferFits({ checklist: ['business_registration'] }, 'persaud')).toBe(false);
    for (const status of [undefined, null, {}, { ownNameFits: null }, { ownNameFits: true }, { ownNameFits: ['persaud'] }, { ownNameFits: { persaud: 'true' } }]) {
      expect(ownNameOfferFits(status, 'persaud'), JSON.stringify(status)).toBe(false);
    }
    for (const storeId of [undefined, null, '']) expect(ownNameOfferFits({ ownNameFits: { persaud: true } }, storeId)).toBe(false);
  });
});
