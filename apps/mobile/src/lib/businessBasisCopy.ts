/**
 * [COMPANY-DOCS · owner rulings 10 Nov 2026 ~07:0xZ, ~07:2xZ] The store sign-up's ONE choice, in plain words: how the
 * business is set up decides the papers the whole account gives (the server's vendor/account-basis.ts):
 *  1. a registered company (incorporated, e.g. KFC): the Certificate of Incorporation, a letter from a director, and the
 *     ID of the ONE person who manages the Swift account. Never an owner's ID. Branches and staff upload nothing.
 *  2. a registered business (a business name registered with the DCRA): the owner's ID and the Business Registration;
 *     or, "I'm the manager, not the owner": the manager's ID, a letter signed by the owner, and the Business Registration.
 *  3. I trade under my own name: my ID and the own-name declaration (lib/ownNameCopy).
 * A person at Swift checks every paper. No React Native import: the website's sign-up reads these words too.
 */

/** What the form holds. `REGISTERED` is the owner of a registered business (or, for a service business, its owner). */
export type SignupBasis = 'COMPANY' | 'REGISTERED' | 'OWN_NAME';

export const BASIS_QUESTION = 'How is your business set up?';
export const COMPANY_CHOICE = 'We’re a registered company (incorporated, for example a “Ltd.” or “Inc.”)';
export const COMPANY_HINT = 'You upload three things: the Certificate of Incorporation, a letter from a director saying you manage the company’s Swift account, and your own ID (National ID, Digital ID card or passport). One person manages your Swift account for the whole company: your branches and your staff don’t upload anything.';
export const REGISTERED_CHOICE = 'We’re a registered business (a business name registered with the DCRA)';
export const REGISTERED_HINT = 'You upload the owner’s ID and the Business Registration.';
export const MANAGER_TICK = 'I’m the manager, not the owner';
export const MANAGER_HINT = 'You upload your own ID (National ID, Digital ID card or passport), the Business Registration, and a letter of authority signed by the owner. Your branches and your staff don’t upload anything.';
/** A service business has no registration to name: its owner signs up, or a registered company does. */
export const SERVICE_OWNER_CHOICE = 'I own this business';
export const SERVICE_OWNER_HINT = 'You upload your ID.';
export const PERSON_CHECKS = 'A person at Swift checks every paper before your store goes live.';

/** The store types offered the manager path (a service business has no registration naming its owner). */
export function managerPathApplies(vendorType: string): boolean {
  return vendorType === 'RESTAURANT' || vendorType === 'SUPERMARKET' || vendorType === 'STORE';
}

/** The choices shown for a type, in the owner's order: company, registered business, own name (stores only). */
export function basisChoicesFor(vendorType: string): SignupBasis[] {
  return managerPathApplies(vendorType) ? ['COMPANY', 'REGISTERED', 'OWN_NAME'] : ['COMPANY', 'REGISTERED'];
}

/**
 * The `accountBasis` POST /partner/become is sent (absent = the owner, as every older build): COMPANY for a company,
 * MANAGER for a registered store's manager. Own name and a plain owner send nothing new.
 */
export function signupAccountBasis(form: { type: string; nameBasis?: SignupBasis; managerNotOwner?: boolean }): 'COMPANY' | 'MANAGER' | undefined {
  if (form.nameBasis === 'COMPANY') return 'COMPANY';
  if (form.nameBasis === 'REGISTERED' && form.managerNotOwner === true && managerPathApplies(form.type)) return 'MANAGER';
  return undefined;
}

/** The website's one-page letters to fill in, sign and upload (apps/web app/letters). A person still checks the signed copy. */
export const AUTHORITY_LETTER_PATHS: Readonly<Record<string, string>> = {
  company_authority_letter: '/letters/company-authority',
  owner_authority_letter: '/letters/owner-authority',
};
export const AUTHORITY_LETTER_LINK = 'Get a one-page letter to fill in and sign';

/** What each company or manager paper is, under its name on the checklist. */
const ACCOUNT_PAPER_HINTS: Readonly<Record<string, string>> = {
  certificate_of_incorporation: 'From the DCRA. If your company trades under a registered business name, its Business Registration is fine too.',
  account_holder_id: 'The ID of the one person who manages this Swift account: you. A National ID, Digital ID card or passport.',
  company_authority_letter: 'On your company’s letterhead, signed and dated by a director, saying you manage the company’s Swift account. Or the company’s list of directors, if you are a director.',
  owner_authority_letter: 'Signed and dated by the owner named on the Business Registration, saying you manage the business’s Swift account.',
};
export function accountPaperHint(docType: string): string | undefined {
  return ACCOUNT_PAPER_HINTS[docType];
}

/**
 * [COMPANY-DOCS · owner 10 Nov 2026] The line above a company's or a manager's checklist (GET /verification/status
 * `accountBasis`): one set of papers for the whole account. Null for an owner, or an older server that sends none.
 */
export function accountBasisNote(status: unknown): string | null {
  const basis = status && typeof status === 'object' ? (status as { accountBasis?: unknown }).accountBasis : undefined;
  if (basis === 'COMPANY') return 'Your company gives these papers once, for the whole account. Your branches and your staff don’t upload anything.';
  if (basis === 'MANAGER') return 'You manage this business for its owner: these papers cover the whole account. Your branches and your staff don’t upload anything.';
  return null;
}

/** A company's or a manager's paper, under its name on the checklist: what it is and, for a letter, the website's one-page
 *  letter to fill in and sign (`site`: swiftgy.com, or the build's own website). Undefined for every other paper. */
export function accountPaperHelp(docType: string, site: string): { text: string; link?: { label: string; url: string } } | undefined {
  const text = accountPaperHint(docType);
  if (!text) return undefined;
  const path = AUTHORITY_LETTER_PATHS[docType];
  return path ? { text, link: { label: AUTHORITY_LETTER_LINK, url: `${site.replace(/\/+$/, '')}${path}` } } : { text };
}
