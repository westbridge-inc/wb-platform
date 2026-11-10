import { describe, expect, it } from 'vitest';
import { accountPathLine, docLabel, reviewerHint } from './review-center';

// [COMPANY-DOCS · owner rulings 10 Nov 2026] The reviewer sees which path a store account signed up on, and each new
// paper by a clear name with what to check. A person decides every one: nothing here approves anything.
describe('[COMPANY-DOCS] review labels for a company’s and a manager’s papers', () => {
  const PAPERS = ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', 'owner_authority_letter'];

  it('each new paper has its own clear name (never the generic “Document”) and a check to make', () => {
    for (const t of PAPERS) {
      expect(docLabel(t), t).not.toBe('Document');
      expect(reviewerHint(t), t).toBeTruthy();
    }
    expect(docLabel('account_holder_id')).not.toBe(docLabel('owner_national_id'));
    expect(reviewerHint('account_holder_id')).toContain('passport');
    expect(reviewerHint('account_holder_id')).toContain('never show this person’s name on the store');
    expect(reviewerHint('company_authority_letter')).toContain('signed and dated by a director');
    expect(reviewerHint('owner_authority_letter')).toContain('owner named on the Business Registration');
  });

  it('the path line says how the account signed up, only for a company or a manager', () => {
    expect(accountPathLine('COMPANY')).toMatch(/registered company.*No owner’s ID is asked for/);
    expect(accountPathLine('MANAGER')).toMatch(/manager of a registered business \(not the owner\)/);
    expect(accountPathLine('OWNER')).toBeNull();
    expect(accountPathLine(null)).toBeNull();
    expect(accountPathLine(undefined)).toBeNull();
  });

  it('the existing labels and hints are unchanged', () => {
    expect(docLabel('owner_national_id')).toBe('National ID');
    expect(docLabel('business_registration')).toBe('Business registration');
    expect(reviewerHint('owner_national_id')).toBeUndefined();
  });
});

describe('[COMPANY-DOCS · review F2, F3, F4, F8] what the reviewer is told to check', () => {
  it('a director’s letter: the signer’s directorship is confirmed independently, never from the form', () => {
    const hint = reviewerHint('company_authority_letter')!;
    expect(hint).toContain('A certificate of incorporation names no directors');
    expect(hint).toMatch(/director listing/);
    expect(hint).toContain('a number Swift finds itself, never a number on the letter or the form');
  });

  it('a company’s business-name registration only when its proprietor is a company; a brand may differ from the company name', () => {
    const hint = reviewerHint('certificate_of_incorporation')!;
    expect(hint).toContain('only when the proprietor named on it is a company (Ltd. or Inc.)');
    expect(hint).toContain('the company’s name or a business name the company has registered');
  });

  it('an expired ID or passport is refused', () => {
    expect(reviewerHint('account_holder_id')).toContain('Refuse an expired ID or passport.');
  });
});
