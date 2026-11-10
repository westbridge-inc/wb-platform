import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_LETTER_LINK, AUTHORITY_LETTER_PATHS, accountBasisNote, accountPaperHelp, accountPaperHint, basisChoicesFor, signupAccountBasis,
} from './businessBasisCopy';
import { docLabel } from '../components/onboarding/docLabels';

// [COMPANY-DOCS · owner rulings 10 Nov 2026] The sign-up's one choice and the checklist's plain words for the new papers.
describe('[COMPANY-DOCS] the choice and the papers, in plain words', () => {
  it('three choices for a store, in the owner’s order; a service business: a company or its owner', () => {
    for (const t of ['RESTAURANT', 'SUPERMARKET', 'STORE']) expect(basisChoicesFor(t)).toEqual(['COMPANY', 'REGISTERED', 'OWN_NAME']);
    expect(basisChoicesFor('SERVICE')).toEqual(['COMPANY', 'REGISTERED']);
  });

  it('the account basis sent: COMPANY, MANAGER (a registered store only), or nothing (the owner, as every older build)', () => {
    expect(signupAccountBasis({ type: 'STORE', nameBasis: 'COMPANY' })).toBe('COMPANY');
    expect(signupAccountBasis({ type: 'STORE', nameBasis: 'REGISTERED', managerNotOwner: true })).toBe('MANAGER');
    expect(signupAccountBasis({ type: 'SERVICE', nameBasis: 'REGISTERED', managerNotOwner: true })).toBeUndefined();
    expect(signupAccountBasis({ type: 'STORE', nameBasis: 'OWN_NAME', managerNotOwner: true })).toBeUndefined();
    expect(signupAccountBasis({ type: 'STORE', nameBasis: 'REGISTERED' })).toBeUndefined();
  });

  it('each new paper has a plain name on the checklist (never the code’s words) and a line saying what it is', () => {
    for (const t of ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', 'owner_authority_letter']) {
      expect(docLabel(t), t).not.toMatch(/_/);
      expect(docLabel(t), t).not.toBe(t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
      expect(accountPaperHint(t), t).toBeTruthy();
    }
    expect(docLabel('account_holder_id')).toContain('passport');
    expect(accountPaperHint('owner_national_id')).toBeUndefined();
  });

  it('the authority letters link to the website’s one-page letters; nothing else does', () => {
    expect(Object.keys(AUTHORITY_LETTER_PATHS).sort()).toEqual(['company_authority_letter', 'owner_authority_letter']);
    expect(AUTHORITY_LETTER_PATHS['company_authority_letter']).toBe('/letters/company-authority');
    expect(AUTHORITY_LETTER_PATHS['owner_authority_letter']).toBe('/letters/owner-authority');
  });

  it('under each paper: what it is, and for a letter the website’s one-page letter (the build’s own site)', () => {
    expect(accountPaperHelp('company_authority_letter', 'https://swiftgy.com')).toEqual({
      text: accountPaperHint('company_authority_letter'),
      link: { label: AUTHORITY_LETTER_LINK, url: 'https://swiftgy.com/letters/company-authority' },
    });
    expect(accountPaperHelp('owner_authority_letter', 'http://localhost:3001/')?.link?.url).toBe('http://localhost:3001/letters/owner-authority');
    expect(accountPaperHelp('account_holder_id', 'https://swiftgy.com')).toEqual({ text: accountPaperHint('account_holder_id') });
    expect(accountPaperHelp('owner_national_id', 'https://swiftgy.com')).toBeUndefined();
  });

  it('a company’s or a manager’s checklist says its papers cover the whole account; an owner’s, or an older server’s, says nothing', () => {
    expect(accountBasisNote({ accountBasis: 'COMPANY' })).toContain('Your branches and your staff don’t upload anything.');
    expect(accountBasisNote({ accountBasis: 'MANAGER' })).toContain('Your branches and your staff don’t upload anything.');
    expect(accountBasisNote({ accountBasis: 'OWNER' })).toBeNull();
    expect(accountBasisNote({})).toBeNull();
    expect(accountBasisNote(null)).toBeNull();
  });
});
