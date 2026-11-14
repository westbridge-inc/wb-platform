/**
 * [COMPANY-DOCS · owner decision 10 Nov 2026 ~07:3xZ (a)] The one-page letters of authority a company's director, or a
 * business's owner, fills in and signs for the person who manages the Swift store account. Plain English, blanks to fill,
 * signature, date and stamp lines. The signed copy is uploaded under Documents, and a person at Swift checks it against
 * the certificate (a director) or the Business Registration (an owner). The words never mention a price or a payment:
 * the phone links here (G-FEE).
 */
import { site } from '@/site.config';

/** Who the letter is addressed to: the operator's own facts (site.config, from the legal operator record). */
const TO_SWIFT = `To: ${site.legalEntityName} (${site.tradeName}), ${site.address}`;

export interface AuthorityLetter {
  kind: 'company' | 'owner';
  title: string;
  /** What the person signing up does with it, shown above the letter (never printed). */
  howTo: string[];
  /** The letter, line by line: a line ending in ':' is followed by a blank to fill in. */
  lines: Array<{ text: string; blank?: boolean; gap?: boolean }>;
  /** The signature block: each one a labelled line. */
  signature: string[];
}

const ACCOUNT_POWERS = 'to open and manage its Swift store account for it: to set up its stores and branches, take and manage orders, keep its menus and prices up to date, add and remove staff, and deal with Swift about the account.';

export const COMPANY_AUTHORITY_LETTER: AuthorityLetter = {
  kind: 'company',
  title: 'Letter of authority: Swift store account (company)',
  howTo: [
    'Print this page on your company’s letterhead, or copy the words onto it.',
    'A director of the company fills in the blanks, signs and dates it, and stamps it if the company has a stamp or seal.',
    'Take a clear photo or scan of the signed letter and upload it on Swift under Documents, as “Letter of authority from a director”.',
    'A person at Swift checks it against your Certificate of Incorporation. Your branches and your staff don’t upload anything.',
  ],
  lines: [
    { text: TO_SWIFT },
    { text: 'Date:', blank: true, gap: true },
    { text: 'Company name (as on the Certificate of Incorporation):', blank: true },
    { text: 'Company registration number:', blank: true, gap: true },
    { text: 'I, the director named below, confirm that the company named above authorises' },
    { text: 'Full name of the person who will manage the account:', blank: true },
    { text: 'Their position in the company:', blank: true },
    { text: `${ACCOUNT_POWERS}`, gap: true },
    { text: 'This person is the only person who manages the company’s Swift account. This authority lasts until the company tells Swift in writing that it has ended.' },
  ],
  signature: ['Director’s signature', 'Director’s full name', 'Date signed', 'Company stamp or seal (if the company has one)'],
};

export const OWNER_AUTHORITY_LETTER: AuthorityLetter = {
  kind: 'owner',
  title: 'Letter of authority: Swift store account (business owner)',
  howTo: [
    'Print this page, or copy the words onto your business’s letterhead.',
    'The owner named on the Business Registration fills in the blanks, signs and dates it, and stamps it if the business has a stamp.',
    'Take a clear photo or scan of the signed letter and upload it on Swift under Documents, as “Letter of authority signed by the business owner”.',
    'A person at Swift checks it against the Business Registration. Your branches and your staff don’t upload anything.',
  ],
  lines: [
    { text: TO_SWIFT },
    { text: 'Date:', blank: true, gap: true },
    { text: 'Business name (as on the Business Registration):', blank: true },
    { text: 'Business registration number:', blank: true, gap: true },
    { text: 'I, the owner of the business named above, as shown on its Business Registration, authorise' },
    { text: 'Full name of the manager:', blank: true },
    { text: `${ACCOUNT_POWERS}`, gap: true },
    { text: 'This person is the only person who manages the business’s Swift account. This authority lasts until I tell Swift in writing that it has ended.' },
  ],
  signature: ['Owner’s signature', 'Owner’s full name', 'Date signed', 'Business stamp (if the business has one)'],
};
