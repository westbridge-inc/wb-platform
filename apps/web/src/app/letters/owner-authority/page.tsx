import type { Metadata } from 'next';
import { AuthorityLetterPage } from '../authority-letter-page';
import { OWNER_AUTHORITY_LETTER } from '../authority-letter';

// [COMPANY-DOCS · owner 10 Nov 2026 (a)] The owner's letter naming the manager who runs a registered business's Swift account.
export const metadata: Metadata = {
  title: 'Letter of authority for a manager',
  description: 'A one-page letter a business owner signs so their manager can manage the business’s Swift store account.',
  // a printable form, not a page to find: never indexed (private-routes-noindex.test)
  robots: { index: false, follow: false },
};

export default function OwnerAuthorityLetter() {
  return <AuthorityLetterPage letter={OWNER_AUTHORITY_LETTER} />;
}
