/**
 * [COMPANY-DOCS PART 2 · review F2 + Part 2 review F1 (COORD ruling 10 Nov 2026, owner to confirm)] A letter of authority
 * is approved only after a PERSON at Swift confirmed, on their own, that the account holder really is authorised.
 *
 * A listing proves a name, not a signature. Anyone can pair a real company's public certificate with a real director's
 * public name and sign as that director themselves: on paper (a forged signature) or in Swift (with their own second
 * SIM: Swift proves only that someone holding the number the ACCOUNT HOLDER TYPED signed). So:
 *  - CALLED_ON_FOUND_NUMBER: the reviewer called the company (or the business) on a number Swift found ITSELF, never a
 *    number on the letter or the form, and it confirmed it authorised THIS account holder. The only proof accepted when
 *    the letter's signer is someone other than the account holder: every letter signed in Swift, and every owner's
 *    letter for a manager (a manager is never the owner).
 *  - REGISTER_LISTING: only for a company's paper that IS its director listing (DCRA notice of directors or annual
 *    return) naming the ACCOUNT HOLDER themself as a director: no one else signed anything (the owner-ruled "or the
 *    director listing" alternative).
 * The reviewer also says what they checked; both are recorded on the review decision. Never by default.
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
  REGISTER_LISTING: 'the paper is the company’s director listing and it names the account holder themself as a director (no one else signed)',
  CALLED_ON_FOUND_NUMBER: 'called the company or business on a number Swift found itself (not the letter’s or the form’s) and it confirmed it authorised this account holder',
};

/**
 * The reviewer's confirmation for a letter of authority, checked; null for every other document. `signedInSwift`: the
 * document is a letter a third person signed in Swift (vendor/authority-letter). Refused (400) when it is missing, names
 * no known method, gives no reason, or relies on a listing where someone other than the account holder signed.
 * The return is the line kept on the review decision.
 */
export function authorityConfirmationNote(docType: string, given: unknown, opts: { signedInSwift?: boolean } = {}): string | null {
  if (!AUTHORITY_LETTER_DOC_TYPES.has(docType)) return null;
  const c = given as Partial<AuthorityConfirmation> | null | undefined;
  const reason = typeof c?.reason === 'string' ? c.reason.trim() : '';
  if (!c || !AUTHORITY_CONFIRMATION_METHODS.includes(c.method as AuthorityConfirmationMethod)
    || reason.length < AUTHORITY_REASON_MIN || reason.length > AUTHORITY_REASON_MAX) {
    throw new AppError(400, 'AUTHORITY_CONFIRMATION_REQUIRED', docType === COMPANY_AUTHORITY_DOC_TYPE
      ? 'Confirm the account holder really is authorised before approving: call the company on a number Swift found itself (never one on the letter or the form) and ask whether it authorised this person; or, if this paper is the company’s director listing, check that it names the account holder themself as a director. Say how and what you checked. A signature, on paper or in Swift, is not proof on its own. If you cannot confirm it, reject the letter.'
      : 'Confirm the account holder really is authorised before approving: call the business on a number Swift found itself (never one on the letter or the form) and ask whether its owner authorised this manager. Say what you checked. A signature, on paper or in Swift, is not proof on its own. If you cannot confirm it, reject the letter.');
  }
  // A listing names people; it never proves who signed. Where someone other than the account holder signed (any letter
  // signed in Swift, any owner's letter), only the call on a number Swift found itself counts.
  if (c.method === 'REGISTER_LISTING' && (opts.signedInSwift === true || docType === OWNER_AUTHORITY_DOC_TYPE)) {
    throw new AppError(400, 'AUTHORITY_CONFIRMATION_CALL_REQUIRED', opts.signedInSwift === true
      ? 'This letter was signed in Swift by someone other than the account holder: a listing cannot prove who signed it. Call the company (or the business) on a number Swift found itself and confirm it authorised this account holder, or reject the letter.'
      : 'An owner’s letter is signed by someone other than the manager: the Business Registration cannot prove who signed it. Call the business on a number Swift found itself and confirm its owner authorised this manager, or reject the letter.');
  }
  return `Confirmed by a person: ${METHOD_WORDS[c.method as AuthorityConfirmationMethod]}. Checked: ${reason}`;
}
