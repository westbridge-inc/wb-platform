/**
 * [COMPANY-DOCS PART 2] The in-app letter of authority collects a THIRD person's name and number (a company's director,
 * or a business's owner). The Privacy Policy must name that before any real partner uses it (owner approves the wording:
 * owner/LEGAL-20261110-COMPANY-DOCS-WORDING.md, then a LEGAL_VERSION bump). Until the owner turns it on, nobody can start
 * a new letter: the account holder sees only the paper letter upload, exactly as before. ON only at exactly 1.
 */
export const AUTHORITY_LETTER_ESIGN_ENV = 'AUTHORITY_LETTER_ESIGN';

export function authorityLetterEsignEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env['AUTHORITY_LETTER_ESIGN'] === '1';
}
