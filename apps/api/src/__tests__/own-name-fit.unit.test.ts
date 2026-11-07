/**
 * [OWNNAME-FIT · COORD ruling 7 Nov 2026, Business Names (Registration) Act Cap. 90:05 s.3] The apps OFFER "No business
 * name? Trade under your own name" only for a store whose name passes the server's own-name test — the same test
 * POST /vendor/onboarding/own-name applies (storeNameIsOwnName). GET /verification/status carries the answer per store
 * as `ownNameFits`. A store named "Westbridge Inc." is never offered a route the server would refuse; missing names
 * never fit. (The status route's wiring is held by own-name-declaration.test.ts against a real database.)
 */
import { describe, expect, it } from 'vitest';
import { ownNameFitsByStore, storeNameIsOwnName } from '../modules/vendor/own-name';

describe('[OWNNAME-FIT] ownNameFits: the own-name route is offered only where the name passes', () => {
  it('a store named for the owner (surname, first names or initials) fits; a trading or company name does not', () => {
    const fits = ownNameFitsByStore([
      { id: 'own', name: 'R. Persaud' },
      { id: 'full', name: 'Ramesh Persaud' },
      { id: 'surname', name: 'Persaud' },
      { id: 'company', name: 'Westbridge Inc.' },
      { id: 'trading', name: 'Persaud Enterprises' },
      { id: 'other', name: 'Best Burgers' },
    ], 'Ramesh', 'Persaud');
    expect(fits).toEqual({ own: true, full: true, surname: true, company: false, trading: false, other: false });
  });

  it('agrees with the signing route\'s own test for every store (one rule, never a second one)', () => {
    const names = ['R. Persaud', 'Westbridge Inc.', 'Persaud Enterprises', 'Ramesh Kumar Persaud', 'R K Persaud', 'Kumar'];
    const fits = ownNameFitsByStore(names.map((name, i) => ({ id: String(i), name })), 'Ramesh Kumar', 'Persaud');
    names.forEach((name, i) => expect(fits[String(i)], name).toBe(storeNameIsOwnName(name, 'Ramesh Kumar', 'Persaud')));
  });

  it('missing or blank first name, last name or store name: never fits', () => {
    for (const [first, last] of [[null, 'Persaud'], ['', 'Persaud'], ['  ', 'Persaud'], ['Ramesh', null], ['Ramesh', ''], [undefined, undefined]] as const) {
      expect(ownNameFitsByStore([{ id: 's', name: 'Persaud' }], first, last), `${first}/${last}`).toEqual({ s: false });
    }
    for (const name of [null, undefined, '', '   ']) expect(ownNameFitsByStore([{ id: 's', name }], 'Ramesh', 'Persaud')).toEqual({ s: false });
    expect(ownNameFitsByStore([], 'Ramesh', 'Persaud')).toEqual({});
  });
});
