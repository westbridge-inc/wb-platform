import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ESIGN_LIMITS, esignFieldLabels, esignOffered, esignSignerFor, esignTitle, letterErrorLine, letterFormState, letterRequestFor, letterStatusLine, resendState,
  type LetterRequestView,
} from './authorityLetterCopy';

// [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The in-app letter of authority's form and status, as the account
// holder sees them on the phone and the website. Synthetic names and numbers only.

const FILLED = {
  businessName: 'Kariba Fried Chicken Ltd.', registrationNumber: 'C-12345', requesterName: 'Asha Ramdin', requesterRole: 'Operations Manager',
  signerName: 'Devon Persaud', signerDigits: '050 0123',
};
const VIEW: LetterRequestView = {
  id: 'r1', docType: 'company_authority_letter', status: 'SENT', signerKind: 'director', signerFirstName: 'Devon', signerPhoneEnding: '123',
  expiresAt: '2026-11-13T15:00:00.000Z', lastSentAt: '2026-11-10T15:00:00.000Z', resendsLeft: 3, resendAt: null, signedAt: null,
};

describe('[COMPANY-DOCS PART 2] who signs which letter', () => {
  it('a company’s letter: a director; a manager’s: the owner; nothing else is signed in Swift', () => {
    expect(esignSignerFor('company_authority_letter')).toBe('director');
    expect(esignSignerFor('owner_authority_letter')).toBe('owner');
    for (const t of ['account_holder_id', 'certificate_of_incorporation', 'owner_national_id', 'own_name_declaration']) expect(esignSignerFor(t)).toBeNull();
    expect(esignTitle('director')).toBe('Ask a director to sign in Swift');
    expect(esignFieldLabels('owner').signerPhone).toBe('The owner’s mobile number');
  });
});

describe('[COMPANY-DOCS PART 2] the form', () => {
  it('a filled form sends the server’s body, the number as +592 and seven digits', () => {
    const s = letterFormState({ ...FILLED, ownPhone: '+5920599999' }, 'director');
    expect(s.canSubmit).toBe(true);
    expect(s.body).toEqual({
      businessName: 'Kariba Fried Chicken Ltd.', registrationNumber: 'C-12345', requesterName: 'Asha Ramdin', requesterRole: 'Operations Manager',
      signerName: 'Devon Persaud', signerPhone: '+5920500123',
    });
  });

  it('the director’s number is never your own, nor one on your team', () => {
    const own = letterFormState({ ...FILLED, ownPhone: '+592 050 0123' }, 'director');
    expect(own.canSubmit).toBe(false);
    expect(own.errors.signerPhone).toBe('The director signs on their own phone. Enter the director’s number, not yours.');
    const team = letterFormState({ ...FILLED, teamPhones: ['+5920500123'] }, 'owner');
    expect(team.errors.signerPhone).toBe('That number belongs to someone on your store’s team. Enter the owner’s own number.');
    expect(letterFormState({ ...FILLED, signerDigits: '60001' }, 'director').errors.signerPhone).toBe('Enter the 7-digit mobile number.');
  });

  it('the signer is someone else than the person asking', () => {
    expect(letterFormState({ ...FILLED, signerName: ' asha ramdin ' }, 'director').errors.signerName).toContain('list of directors');
    expect(letterFormState({ ...FILLED, signerName: 'Asha Ramdin' }, 'owner').errors.signerName).toBe('The owner is someone else: enter the owner’s name.');
  });

  it('each field within the server’s own limits (the API’s letterFormSchema), so the button never enables a refused form', () => {
    const routes = readFileSync(join(__dirname, '../../../api/src/modules/vendor/authority-letter/authority-letter.routes.ts'), 'utf8');
    for (const [field, [min, max]] of Object.entries(ESIGN_LIMITS)) {
      expect(routes, field).toMatch(new RegExp(`${field}: text\\(${min}, ${max}\\)`));
      expect(letterFormState({ ...FILLED, [field]: 'x'.repeat(max + 1) }, 'director').errors[field as keyof typeof ESIGN_LIMITS]).toBe(`Use at most ${max} characters.`);
    }
    expect(letterFormState({ ...FILLED, businessName: ' ' }, 'director').errors.businessName).toBe('Fill this in.');
  });

  it('[review F6] hidden characters (bidi overrides, zero-width, private-use, control) are refused as the server refuses them', () => {
    for (const hidden of ['‮', '​', '⁦', '', '\u0007', ' ']) {
      const s = letterFormState({ ...FILLED, signerName: `Devon${hidden} Persaud` }, 'director');
      expect(s.canSubmit, JSON.stringify(hidden)).toBe(false);
      expect(s.errors.signerName).toBe('Remove the hidden characters (copied text can carry them): type it again.');
    }
    expect(letterFormState({ ...FILLED, businessName: 'O’Neil & Sons Ltd.' }, 'director').canSubmit).toBe(true); // ordinary punctuation passes
  });
});

describe('[COMPANY-DOCS PART 2] where it stands', () => {
  it('waiting for the director by first name, with the number’s ending; expired; signed', () => {
    expect(letterStatusLine(VIEW)).toBe('Waiting for Devon to sign. We texted the link to the number ending 123. It works for 72 hours.');
    expect(letterStatusLine({ ...VIEW, status: 'EXPIRED' })).toBe('The link to Devon expired before it was signed. Send it again, or change the details.');
    expect(letterStatusLine({ ...VIEW, status: 'SIGNED' })).toBe('Devon signed the letter. A person at Swift is checking it.');
  });

  it('the form is offered only when the server says signing in Swift is on (off, or an older server: paper only)', () => {
    expect(esignOffered({ enabled: true, request: null })).toBe(true);
    expect(esignOffered({ enabled: false, request: null })).toBe(false);
    expect(esignOffered({ request: null })).toBe(false);
    expect(esignOffered(undefined)).toBe(false);
  });

  it('a cancelled request, or one for the other letter, shows the form again', () => {
    expect(letterRequestFor('company_authority_letter', { request: VIEW })).toEqual(VIEW);
    expect(letterRequestFor('company_authority_letter', { request: { ...VIEW, status: 'CANCELLED' } })).toBeNull();
    expect(letterRequestFor('owner_authority_letter', { request: VIEW })).toBeNull();
    expect(letterRequestFor('company_authority_letter', { request: null })).toBeNull();
  });

  it('resend: one a minute, and only as many as the server says are left', () => {
    const now = Date.parse('2026-11-10T15:00:30.000Z');
    expect(resendState({ ...VIEW, resendAt: '2026-11-10T15:01:00.000Z' }, now)).toEqual({ allowed: false, label: 'Send again in 30 s' });
    expect(resendState(VIEW, now)).toEqual({ allowed: true, label: 'Send the link again' });
    expect(resendState({ ...VIEW, resendsLeft: 0 }, now).allowed).toBe(false);
    expect(resendState({ ...VIEW, status: 'SIGNED' }, now).allowed).toBe(false);
  });

  it('a refusal in the server’s words, from the phone’s client or the website’s', () => {
    expect(letterErrorLine({ response: { data: { error: { message: 'Too many texts to this number today.' } } } })).toBe('Too many texts to this number today.');
    expect(letterErrorLine(Object.assign(new Error('That number belongs to someone on your store’s team.'), { name: 'ApiRequestError' }))).toBe('That number belongs to someone on your store’s team.');
    expect(letterErrorLine(new Error('Request failed with status code 400'))).toBe('Couldn’t send that. Check your connection and try again.');
  });
});
