import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CompanyAuthorityLetter from './company-authority/page';
import OwnerAuthorityLetter from './owner-authority/page';
import { COMPANY_AUTHORITY_LETTER, OWNER_AUTHORITY_LETTER } from './authority-letter';
import { AUTHORITY_LETTER_PATHS } from '@/lib/business-basis';

// [COMPANY-DOCS · owner decision 10 Nov 2026 (a)] One-page letters of authority to fill in, sign and upload: plain words,
// blanks, signature, date and stamp lines. The phone links here, so no price or payment word is ever on them (G-FEE).
describe('[COMPANY-DOCS] the letters of authority', () => {
  it.each([
    ['company', CompanyAuthorityLetter, COMPANY_AUTHORITY_LETTER, 'Director’s signature', 'Company stamp or seal (if the company has one)'],
    ['owner', OwnerAuthorityLetter, OWNER_AUTHORITY_LETTER, 'Owner’s signature', 'Business stamp (if the business has one)'],
  ] as const)('the %s letter: who authorises whom, for which business, with blanks and signature lines', (kind, Page, letter, signature, stamp) => {
    render(<Page />);
    const article = screen.getByRole('article', { name: letter.title });
    expect(article.getAttribute('data-letter')).toBe(kind);
    const text = article.textContent!;
    expect(text).toContain('To: Westbridge Inc. (Swift), Georgetown, Guyana');
    expect(text).toContain('registration number:');
    expect(text).toContain('manage its Swift store account');
    expect(text).toContain('until');
    for (const label of [signature, 'Date signed', stamp]) expect(within(article).getByText(`${label}:`)).toBeTruthy();
    // the steps are on screen, never on the printed page, and say a person checks it
    expect(screen.getByText(/A person at Swift checks it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Print or save as PDF' })).toBeTruthy();
    // (menu prices are the store's own; Swift's fee and any payment are never on the letter)
    expect(text).not.toMatch(/\bfees?\b|subscription|GY\$|\bpay(s|ing|ment|ments)?\b|weekly/i);
  });

  it('the paths the phone and the Documents page link to are these pages', () => {
    expect(AUTHORITY_LETTER_PATHS['company_authority_letter']).toBe('/letters/company-authority');
    expect(AUTHORITY_LETTER_PATHS['owner_authority_letter']).toBe('/letters/owner-authority');
  });
});
