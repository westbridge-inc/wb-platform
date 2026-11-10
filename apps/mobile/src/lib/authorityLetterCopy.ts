/**
 * [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The in-app letter of authority, as the account holder meets it on
 * the Documents checklist (phone and website): a short form; Swift writes a one-page letter and texts the director (a
 * company) or the owner (a manager's business) a link; they confirm a code texted to THEIR phone and sign with a finger;
 * a person at Swift checks the signed letter. The paper letter upload stays under it as the fallback (Part 1).
 *
 * The form's limits mirror the server's (apps/api vendor/authority-letter/authority-letter.routes.ts letterFormSchema),
 * so the button never enables a form the server would refuse. No React Native import: the website reads these too.
 */

/** The letters that can be signed in Swift, and who signs each. */
export const ESIGN_SIGNER: Readonly<Record<string, 'director' | 'owner'>> = {
  company_authority_letter: 'director',
  owner_authority_letter: 'owner',
};

export function esignSignerFor(docType: string): 'director' | 'owner' | null {
  return ESIGN_SIGNER[docType] ?? null;
}

export function esignTitle(kind: 'director' | 'owner'): string {
  return kind === 'director' ? 'Ask a director to sign in Swift' : 'Ask the owner to sign in Swift';
}

export function esignIntro(kind: 'director' | 'owner'): string {
  return kind === 'director'
    ? 'Swift writes a one-page letter from these details and texts a director of the company a link. They read it and sign with their finger on their own phone: no app or account needed. A person at Swift checks the signed letter.'
    : 'Swift writes a one-page letter from these details and texts the business’s owner a link. They read it and sign with their finger on their own phone: no app or account needed. A person at Swift checks the signed letter.';
}

export const ESIGN_PAPER_FALLBACK = 'Prefer paper? Upload a signed letter instead.';
export const ESIGN_SEND = 'Send the letter to sign';
export const ESIGN_RESEND = 'Send the link again';
export const ESIGN_CANCEL = 'Cancel and change the details';

export type LetterField = 'businessName' | 'registrationNumber' | 'requesterName' | 'requesterRole' | 'signerName' | 'signerPhone';

export function esignFieldLabels(kind: 'director' | 'owner'): Record<LetterField, string> {
  return kind === 'director'
    ? {
      businessName: 'Company name (as on the Certificate of Incorporation)',
      registrationNumber: 'Company registration number',
      requesterName: 'Your full name',
      requesterRole: 'Your position in the company',
      signerName: 'The director’s full name',
      signerPhone: 'The director’s mobile number',
    }
    : {
      businessName: 'Business name (as on the Business Registration)',
      registrationNumber: 'Business registration number',
      requesterName: 'Your full name',
      requesterRole: 'Your position (for example, Manager)',
      signerName: 'The owner’s full name',
      signerPhone: 'The owner’s mobile number',
    };
}

/** The server's limits, field by field: [min, max] characters after trimming. */
export const ESIGN_LIMITS: Readonly<Record<Exclude<LetterField, 'signerPhone'>, readonly [number, number]>> = {
  businessName: [2, 120],
  registrationNumber: [1, 40],
  requesterName: [3, 80],
  requesterRole: [2, 60],
  signerName: [3, 80],
};

/** Local digits of a Guyana mobile number (after +592). */
export const SIGNER_DIGITS = 7;

export interface LetterFormInput {
  businessName: string;
  registrationNumber: string;
  requesterName: string;
  requesterRole: string;
  signerName: string;
  /** The local digits as typed, without the calling code. */
  signerDigits: string;
  /** The signed-in account's own number: the signer is never the account holder. */
  ownPhone?: string | null;
  /** Numbers already on the store's team, when the screen knows them (the server checks them anyway). */
  teamPhones?: readonly string[];
}

export interface LetterFormState {
  canSubmit: boolean;
  errors: Partial<Record<LetterField, string>>;
  /** What POST /vendor/authority-letters receives. */
  body: { businessName: string; registrationNumber: string; requesterName: string; requesterRole: string; signerName: string; signerPhone: string };
}

const digitsOf = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

/** The form's rules: every field within the server's limits, and the signer's number neither yours nor your team's. */
export function letterFormState(input: LetterFormInput, kind: 'director' | 'owner', dialCode = '+592'): LetterFormState {
  const errors: Partial<Record<LetterField, string>> = {};
  const trimmed = {
    businessName: input.businessName.trim(), registrationNumber: input.registrationNumber.trim(), requesterName: input.requesterName.trim(),
    requesterRole: input.requesterRole.trim(), signerName: input.signerName.trim(),
  };
  for (const field of Object.keys(ESIGN_LIMITS) as Array<keyof typeof ESIGN_LIMITS>) {
    const [min, max] = ESIGN_LIMITS[field];
    const value = trimmed[field];
    if (value.length < min) errors[field] = 'Fill this in.';
    else if (value.length > max) errors[field] = `Use at most ${max} characters.`;
    else if (/[<>]/.test(value)) errors[field] = 'Use letters, numbers and ordinary punctuation.';
    // [review F6] as the server refuses them: invisible formatting (bidi, zero-width), private-use and control characters
    else if (/[\p{Cc}\p{Cf}\p{Co}\u2028\u2029]/u.test(value)) errors[field] = 'Remove the hidden characters (copied text can carry them): type it again.';
  }
  const local = digitsOf(input.signerDigits).slice(0, SIGNER_DIGITS);
  const signerPhone = `${dialCode}${local}`;
  if (local.length !== SIGNER_DIGITS) {
    errors.signerPhone = `Enter the ${SIGNER_DIGITS}-digit mobile number.`;
  } else if (digitsOf(input.ownPhone) === digitsOf(signerPhone)) {
    errors.signerPhone = `The ${kind} signs on their own phone. Enter the ${kind}’s number, not yours.`;
  } else if ((input.teamPhones ?? []).some((p) => digitsOf(p) === digitsOf(signerPhone))) {
    errors.signerPhone = `That number belongs to someone on your store’s team. Enter the ${kind}’s own number.`;
  }
  if (trimmed.signerName && trimmed.requesterName && trimmed.signerName.toLowerCase() === trimmed.requesterName.toLowerCase() && !errors.signerName) {
    errors.signerName = kind === 'director'
      ? 'The director is someone else. If you are a director, upload the company’s list of directors instead.'
      : 'The owner is someone else: enter the owner’s name.';
  }
  return { canSubmit: Object.keys(errors).length === 0, errors, body: { ...trimmed, signerPhone } };
}

/** What the account holder's request looks like (GET /vendor/authority-letters `request`). */
export interface LetterRequestView {
  id: string;
  docType: string;
  status: 'SENT' | 'SIGNED' | 'EXPIRED' | 'CANCELLED';
  signerKind: 'director' | 'owner';
  signerFirstName: string;
  signerPhoneEnding: string;
  expiresAt: string;
  lastSentAt: string;
  resendsLeft: number;
  resendAt: string | null;
  signedAt: string | null;
}

/** Whether the form is offered: only when the server says signing in Swift is switched on (GET `enabled`). An older
 *  server, or the switch off (until the owner approves the privacy wording): the paper letter only. */
export function esignOffered(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { enabled?: unknown }).enabled === true;
}

/** The request this letter row shows: the newest one for this letter, unless it was cancelled (then the form again). */
export function letterRequestFor(docType: string, data: unknown): LetterRequestView | null {
  const r = (data && typeof data === 'object' ? (data as { request?: unknown }).request : null) as LetterRequestView | null | undefined;
  if (!r || typeof r !== 'object' || r.docType !== docType || r.status === 'CANCELLED') return null;
  return r;
}

/** One line on where it stands: "Waiting for Devon to sign …". */
export function letterStatusLine(r: LetterRequestView): string {
  const who = r.signerFirstName || `the ${r.signerKind}`;
  switch (r.status) {
    case 'SENT':
      return `Waiting for ${who} to sign. We texted the link to the number ending ${r.signerPhoneEnding}. It works for 72 hours.`;
    case 'EXPIRED':
      return `The link to ${who} expired before it was signed. Send it again, or change the details.`;
    case 'SIGNED':
      return `${who} signed the letter. A person at Swift is checking it.`;
    default:
      return '';
  }
}

/** Whether "Send the link again" can be pressed now, and the words on it. */
export function resendState(r: LetterRequestView, now = Date.now()): { allowed: boolean; label: string } {
  if (r.status !== 'SENT' && r.status !== 'EXPIRED') return { allowed: false, label: ESIGN_RESEND };
  if (r.resendsLeft <= 0) return { allowed: false, label: 'No more resends: change the details to start again' };
  const wait = r.resendAt ? Math.ceil((Date.parse(r.resendAt) - now) / 1000) : 0;
  return wait > 0 ? { allowed: false, label: `Send again in ${wait} s` } : { allowed: true, label: ESIGN_RESEND };
}

/** The server's own words for a refusal, or a plain retry line. */
export function letterErrorLine(error: unknown): string {
  const e = error as { name?: unknown; response?: { data?: { error?: { message?: unknown } } }; message?: unknown } | null;
  // the phone's client (axios): the server's body; the website's (ApiRequestError): the server's message itself
  const message = e?.response?.data?.error?.message ?? (e?.name === 'ApiRequestError' ? e.message : undefined);
  if (typeof message === 'string' && message) return message;
  return 'Couldn’t send that. Check your connection and try again.';
}
