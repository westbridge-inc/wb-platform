'use client';

/**
 * [COMPANY-DOCS PART 2 · review F2] The reviewer's own confirmation of a letter of authority's signer, required before
 * the letter can be approved (the server refuses it otherwise: AUTHORITY_CONFIRMATION_REQUIRED). A signature is not
 * proof on its own, on paper or in Swift: a letter signed in Swift proves only that someone holding the number the
 * ACCOUNT HOLDER TYPED confirmed a code and signed. The reviewer says how they confirmed the signer and what they checked.
 */
export type AuthorityMethod = 'REGISTER_LISTING' | 'CALLED_ON_FOUND_NUMBER';
export interface AuthorityConfirmationValue { method: AuthorityMethod | ''; reason: string }
export const EMPTY_AUTHORITY: AuthorityConfirmationValue = { method: '', reason: '' };
export const AUTHORITY_REASON_MIN = 10;

export function authorityConfirmationReady(v: AuthorityConfirmationValue): boolean {
  const reason = v.reason.trim();
  return v.method !== '' && reason.length >= AUTHORITY_REASON_MIN && reason.length <= 500;
}

export function authorityChoices(docType: string): Array<{ method: AuthorityMethod; label: string }> {
  return docType === 'owner_authority_letter'
    ? [
      { method: 'REGISTER_LISTING', label: 'The Business Registration names the signer as the owner' },
      { method: 'CALLED_ON_FOUND_NUMBER', label: 'I called the business on a number Swift found itself (not one on the letter or the form) and it confirmed the signer is the owner' },
    ]
    : [
      { method: 'REGISTER_LISTING', label: 'The company’s director listing (DCRA notice of directors or annual return) names the signer as a director' },
      { method: 'CALLED_ON_FOUND_NUMBER', label: 'I called the company on a number Swift found itself (not one on the letter or the form) and it confirmed the signer is a director' },
    ];
}

export const AUTHORITY_NOT_PROOF = 'A signature is not proof on its own. If this letter was signed in Swift, its signing record says the number was typed by the account holder: Swift never checked that it belongs to the director, the owner or the company. Confirm the signer yourself. If you cannot, reject the letter.';

export function AuthorityConfirmationFields({ docType, value, onChange, disabled }: {
  docType: string; value: AuthorityConfirmationValue; onChange: (_v: AuthorityConfirmationValue) => void; disabled: boolean;
}) {
  const who = docType === 'owner_authority_letter' ? 'the owner' : 'a director';
  return (
    <fieldset className="rc-fields" disabled={disabled} data-authority-confirmation>
      <legend>Signer confirmed (required)</legend>
      <p className="rc-reviewer-hint">{AUTHORITY_NOT_PROOF}</p>
      {authorityChoices(docType).map((c) => (
        <label key={c.method} className="rc-check">
          <input type="radio" name="authority-method" value={c.method} checked={value.method === c.method} onChange={() => onChange({ ...value, method: c.method })} />
          {c.label}
        </label>
      ))}
      <label>What you checked
        <textarea
          aria-label="What you checked to confirm the signer" maxLength={500} value={value.reason}
          placeholder={`For example: the DCRA annual return lists the signer as ${who}`}
          onChange={(e) => onChange({ ...value, reason: e.target.value })}
        />
        <small>{value.reason.trim().length < AUTHORITY_REASON_MIN ? `At least ${AUTHORITY_REASON_MIN} characters. Kept with the decision.` : 'Kept with the decision.'}</small>
      </label>
    </fieldset>
  );
}
