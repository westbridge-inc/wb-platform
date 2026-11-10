/**
 * [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The in-app letter of authority: the words, written by the server.
 *
 * The person signing up a company's store account (or a registered business's manager) fills a short form; Swift writes
 * ONE clean page in plain English: who authorises whom, for which business and registration number, to manage its Swift
 * store account (orders, menus and items, staff, the weekly fee) and the date. The director (or the owner) reads exactly
 * these words on their own phone and signs them; the SHA-256 of the words is kept with the signature, so what was signed
 * is provably what was shown. Part 1's paper letters (apps/web app/letters) stay the fallback, in the same terms.
 *
 * Pure: no database, no network. The signer's name and number are a third person's details: they appear in the letter
 * and the signed PDF only, never in a log or an audit row.
 */
import { createHash } from 'node:crypto';
import { OPERATOR, OPERATOR_ADDRESS } from '../../legal/operator';
import { COMPANY_AUTHORITY_DOC_TYPE, OWNER_AUTHORITY_DOC_TYPE } from '../../verification/doc-registry';
import { formatGuyanaTime } from '../../../utils/guyana-day';

/** The account bases that sign a letter of authority (Part 1: vendor/account-basis.ts). */
export type LetterBasis = 'COMPANY' | 'MANAGER';

/** The letter each basis gives (a company's director, or a registered business's owner). */
export const LETTER_DOC_TYPE: Readonly<Record<LetterBasis, string>> = {
  COMPANY: COMPANY_AUTHORITY_DOC_TYPE,
  MANAGER: OWNER_AUTHORITY_DOC_TYPE,
};

/** How long a link works, and the other limits of one request. */
export const LINK_TTL_MS = 72 * 3600_000;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
/** Codes one request may text (across its resends). */
export const CODE_MAX_SENDS = 6;
/** After the code: how long the signer has to draw and send their signature. */
export const SIGNING_KEY_TTL_MS = 30 * 60_000;
/** The first text plus this many resends. */
export const MAX_RESENDS = 3;
export const RESEND_COOLDOWN_MS = 60_000;
/** Requests one account may start in 24 hours (each one texts a number the account typed). */
export const MAX_REQUESTS_PER_DAY = 5;
/** A request that ended unsigned keeps the signer's name and number this long, then is deleted. */
export const ENDED_RETENTION_DAYS = 30;

/** What the person signing up types. */
export interface LetterForm {
  businessName: string;
  registrationNumber: string;
  requesterName: string;
  requesterRole: string;
  signerName: string;
}

export interface LetterWords {
  title: string;
  lines: string[];
  /** The words as one text (lines joined by a newline): what is hashed and stored. */
  text: string;
  sha256: string;
}

/** One line of a name or a number, as typed: spaces collapsed, no control characters. */
export function cleanField(value: string): string {
  return value.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** The date the letter is written, in Guyana: "10 November 2026". */
export function letterDate(at: Date): string {
  return formatGuyanaTime(at, { day: 'numeric', month: 'long', year: 'numeric' });
}

const powers = (whose: string) => `to open and manage ${whose} Swift store account for it: to set up its stores and branches, `
  + 'take and manage orders, keep its menus, items and prices up to date, add and remove staff, pay and manage the weekly '
  + 'Swift fee for the account, and deal with Swift about the account.';

const SIGNING = 'I am signing this letter electronically, on my own phone, after confirming a code Swift texted to my number.';

/** The one-page letter for a company's director (COMPANY) or a registered business's owner (MANAGER). */
export function authorityLetterWords(basis: LetterBasis, form: LetterForm, writtenAt: Date): LetterWords {
  const f = {
    businessName: cleanField(form.businessName), registrationNumber: cleanField(form.registrationNumber),
    requesterName: cleanField(form.requesterName), requesterRole: cleanField(form.requesterRole), signerName: cleanField(form.signerName),
  };
  const head = [`To: ${OPERATOR.name} (${OPERATOR.tradingAs}), ${OPERATOR_ADDRESS}`, `Date: ${letterDate(writtenAt)}`];
  const lines = basis === 'COMPANY'
    ? [
      ...head,
      `Company: ${f.businessName}`,
      `Company registration number: ${f.registrationNumber}`,
      `I, ${f.signerName}, a director of ${f.businessName}, confirm that the company authorises ${f.requesterName} (${f.requesterRole}) ${powers('the company’s')}`,
      `${f.requesterName} is the only person who manages the company’s Swift account. This authority lasts until the company tells Swift in writing that it has ended.`,
      SIGNING,
    ]
    : [
      ...head,
      `Business: ${f.businessName}`,
      `Business registration number: ${f.registrationNumber}`,
      `I, ${f.signerName}, the owner of ${f.businessName} as shown on its Business Registration, authorise ${f.requesterName} (${f.requesterRole}) ${powers('the business’s')}`,
      `${f.requesterName} is the only person who manages the business’s Swift account. This authority lasts until I tell Swift in writing that it has ended.`,
      SIGNING,
    ];
  const title = basis === 'COMPANY' ? 'Letter of authority: Swift store account (company)' : 'Letter of authority: Swift store account (business owner)';
  const text = [title, ...lines].join('\n');
  return { title, lines, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

/** Who signs, in the signer-up's words: "the director" / "the owner". */
export function signerKind(basis: LetterBasis): 'director' | 'owner' {
  return basis === 'COMPANY' ? 'director' : 'owner';
}

/** The first name the signer-up sees in "Waiting for <first name> to sign". */
export function firstNameOf(fullName: string): string {
  return cleanField(fullName).split(' ')[0] ?? '';
}

/** The last three digits of a number: all the signer-up and the signing page are shown of it. */
export function phoneEnding(phone: string): string {
  return phone.replace(/\D/g, '').slice(-3);
}

/** A text message in plain GSM characters (one cheap part per 160): curly quotes straightened, anything else dropped. */
export function smsSafe(value: string): string {
  return value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '');
}

/** The text with the link. Names only who asks and for which business; the secret sits after '#' (never in a log). */
export function letterLinkSms(input: { requesterName: string; businessName: string; basis: LetterBasis; link: string }): string {
  const who = smsSafe(firstNameOf(input.requesterName)) || 'Someone';
  const business = smsSafe(cleanField(input.businessName)).slice(0, 60);
  return `Swift: ${who} asked you to sign a letter of authority for ${business} on Swift. Read and sign it here: ${input.link} Not expecting this? Ignore this text.`;
}

/** The code text. */
export function letterCodeSms(code: string): string {
  return `Your Swift code to sign the letter of authority is ${code}. It expires in 10 minutes. Never share it.`;
}

/** The signing page's address with the link's secret after '#'. */
export function signingLink(token: string, base = process.env['APP_PUBLIC_URL'] ?? 'https://swiftgy.com'): string {
  return `${base.replace(/\/+$/, '')}/sign-letter#${token}`;
}
