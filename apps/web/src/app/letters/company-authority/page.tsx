import type { Metadata } from 'next';
import { AuthorityLetterPage } from '../authority-letter-page';
import { COMPANY_AUTHORITY_LETTER } from '../authority-letter';

// [COMPANY-DOCS · owner 10 Nov 2026 (a)] The director's letter naming the one person who manages a company's Swift account.
export const metadata: Metadata = {
  title: 'Letter of authority for a company',
  description: 'A one-page letter a company director signs so one person can manage the company’s Swift store account.',
  // a printable form, not a page to find: never indexed (private-routes-noindex.test)
  robots: { index: false, follow: false },
};

export default function CompanyAuthorityLetter() {
  return <AuthorityLetterPage letter={COMPANY_AUTHORITY_LETTER} />;
}
