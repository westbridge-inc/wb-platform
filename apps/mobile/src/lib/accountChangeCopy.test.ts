import { describe, expect, it } from 'vitest';
import { COMPANY_CHOICE, REGISTERED_CHOICE } from './businessBasisCopy';
import { OWN_NAME_CHOICE } from './ownNameCopy';
import { changeStatusLine, namedLine, optionWords, paperStateWords, type AccountChangeView } from './accountChangeCopy';

const change = (over: Partial<AccountChangeView>): AccountChangeView => ({
  id: 'c1', kind: 'BUSINESS_TYPE', status: 'PENDING', fromOption: 'OWN_NAME', toOption: 'COMPANY', createdAt: '2026-11-10T08:00:00.000Z',
  decidedAt: null, refusalReason: null, accepted: null, papers: [], papersComplete: false, ...over,
});

describe('[COMPANY-DOCS Part 3] Change business type, in sign-up’s own words', () => {
  it('each answer reads exactly as at sign-up (one source for the phone and the website)', () => {
    expect(optionWords('COMPANY')).toBe(COMPANY_CHOICE);
    expect(optionWords('REGISTERED')).toBe(REGISTERED_CHOICE);
    expect(optionWords('OWN_NAME')).toBe(OWN_NAME_CHOICE);
    expect(optionWords('MANAGER')).toContain(REGISTERED_CHOICE);
    expect(optionWords('MANAGER')).toContain('manager, not the owner');
  });

  it('says where the change stands: waiting papers, waiting for a person, done, refused with the reason, withdrawn', () => {
    expect(changeStatusLine(change({}))).toMatch(/Upload the papers below/);
    expect(changeStatusLine(change({ papersComplete: true }))).toMatch(/a person at Swift now decides/);
    expect(changeStatusLine(change({ status: 'APPROVED' }))).toBe('Your business type is now a registered company.');
    const refused = changeStatusLine(change({ status: 'REFUSED', refusalReason: 'The letter names another director' }));
    expect(refused).toContain('The letter names another director');
    expect(refused).toContain('kept selling');
    expect(changeStatusLine(change({ status: 'WITHDRAWN' }))).toMatch(/Nothing changed/);
  });

  it('a handover reads for the holder, and for the person named', () => {
    expect(changeStatusLine(change({ kind: 'HOLDER_HANDOVER', toOption: null, accepted: false }))).toMatch(/say yes/);
    expect(changeStatusLine(change({ kind: 'HOLDER_HANDOVER', toOption: null, status: 'REFUSED', refusalReason: 'Wrong person' }))).toContain('Wrong person');
    expect(namedLine({ storeNames: ['Chicken Co'] })).toBe('Chicken Co named you as the new account holder on Swift.');
    expect(namedLine({ storeNames: ['Chicken Co', 'Chicken Co North', 'Chicken Co South'] })).toBe('Chicken Co and 2 more branches named you as the new account holder on Swift.');
  });

  it('never says a paper is "verified": a person checked it', () => {
    for (const state of ['APPROVED', 'PENDING', 'REJECTED', 'MISSING'] as const) expect(paperStateWords(state)).not.toMatch(/verif/i);
  });
});
