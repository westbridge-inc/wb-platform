/**
 * [COMPANY-DOCS PART 2 · review F2 (coordinator, 10 Nov 2026)] A letter of authority is approved only after a PERSON at
 * Swift confirmed, on their own, that its signer really is a director of the company (or the owner of the business).
 *
 * Why: anyone can pair a copy of a real company's certificate with a "director" who is really an accomplice. A paper
 * letter proves only that someone signed a paper; a letter signed in Swift proves only that someone holding the number
 * the ACCOUNT HOLDER TYPED confirmed a code and signed (Swift never checks that number belongs to the director or the
 * company). Neither is proof of authority on its own. So the approval names HOW the signer was confirmed:
 *  - REGISTER_LISTING: an official listing names the signer (a company's director listing: the DCRA notice of directors
 *    or annual return; a business's Business Registration naming its owner);
 *  - CALLED_ON_FOUND_NUMBER: the reviewer called the company (or the business) on a number Swift found ITSELF, never a
 *    number on the letter or the form, and it confirmed the signer;
 * and WHY (what exactly was checked), recorded on the review decision. Paper and in-app letters alike; never by default.
 */
import { AppError } from '../../utils/errors';
import { COMPANY_AUTHORITY_DOC_TYPE, OWNER_AUTHORITY_DOC_TYPE } from './doc-registry';

export const AUTHORITY_LETTER_DOC_TYPES: ReadonlySet<string> = new Set([COMPANY_AUTHORITY_DOC_TYPE, OWNER_AUTHORITY_DOC_TYPE]);

export const AUTHORITY_CONFIRMATION_METHODS = ['REGISTER_LISTING', 'CALLED_ON_FOUND_NUMBER'] as const;
export type AuthorityConfirmationMethod = (typeof AUTHORITY_CONFIRMATION_METHODS)[number];
export interface AuthorityConfirmation { method: AuthorityConfirmationMethod; reason: string }

export const AUTHORITY_REASON_MIN = 10;
export const AUTHORITY_REASON_MAX = 500;

const METHOD_WORDS: Readonly<Record<AuthorityConfirmationMethod, string>> = {
  REGISTER_LISTING: 'an official listing names the signer (director listing, or the Business Registration for an owner)',
  CALLED_ON_FOUND_NUMBER: 'called the company or business on a number Swift found itself (not the letter’s or the form’s)',
};

/**
 * The reviewer's confirmation for a letter of authority, checked; null for every other document. Refused (400) when it
 * is missing, names no known method, or gives no reason. The return is the line kept on the review decision.
 */
export function authorityConfirmationNote(docType: string, given: unknown): string | null {
  if (!AUTHORITY_LETTER_DOC_TYPES.has(docType)) return null;
  const c = given as Partial<AuthorityConfirmation> | null | undefined;
  const reason = typeof c?.reason === 'string' ? c.reason.trim() : '';
  if (!c || !AUTHORITY_CONFIRMATION_METHODS.includes(c.method as AuthorityConfirmationMethod)
    || reason.length < AUTHORITY_REASON_MIN || reason.length > AUTHORITY_REASON_MAX) {
    throw new AppError(400, 'AUTHORITY_CONFIRMATION_REQUIRED', docType === COMPANY_AUTHORITY_DOC_TYPE
      ? 'Confirm the signer really is a director before approving: from the company’s director listing (DCRA notice of directors or annual return), or by calling the company on a number Swift found itself. Say how and what you checked. A signature, on paper or in Swift, is not proof on its own. If you cannot confirm it, reject the letter.'
      : 'Confirm the signer really is the business’s owner before approving: from the Business Registration, or by calling the business on a number Swift found itself. Say how and what you checked. A signature, on paper or in Swift, is not proof on its own. If you cannot confirm it, reject the letter.');
  }
  return `Signer confirmed by a person: ${METHOD_WORDS[c.method as AuthorityConfirmationMethod]}. Checked: ${reason}`;
}
