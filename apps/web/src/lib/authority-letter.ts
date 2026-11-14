/**
 * [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The in-app letter of authority on the website's Documents page: the
 * phone's own words and form rules (apps/mobile lib/authorityLetterCopy), one source for both apps, and the website's
 * calls to the API (the account holder only; every request carries the selected store, lib/auth apiFetch).
 */
import { apiFetch } from './auth';
import type { LetterRequestView } from '../../../mobile/src/lib/authorityLetterCopy';

export {
  ESIGN_CANCEL, ESIGN_LIMITS, ESIGN_PAPER_FALLBACK, ESIGN_RESEND, ESIGN_SEND, SIGNER_DIGITS, esignFieldLabels, esignIntro, esignOffered, esignSignerFor,
  esignTitle, letterErrorLine, letterFormState, letterRequestFor, letterStatusLine, resendState,
} from '../../../mobile/src/lib/authorityLetterCopy';
export type { LetterField, LetterFormInput, LetterRequestView } from '../../../mobile/src/lib/authorityLetterCopy';

export interface AuthorityLetterRead { enabled?: boolean; accountBasis: string; request: LetterRequestView | null }

const BASE = '/api/v1/vendor/authority-letters';

/** GET: the account's newest letter request (null when none). */
export const getAuthorityLetter = () => apiFetch(BASE).then((r) => r.data as AuthorityLetterRead);

/** POST: Swift writes the letter and texts the director (or the owner) the link. */
export const askAuthorityLetter = (body: Record<string, string>) =>
  apiFetch(BASE, { method: 'POST', body: JSON.stringify(body) }).then((r) => (r.data as { request: LetterRequestView }).request);

/** POST /:id/resend: a new link (the old one stops working). */
export const resendAuthorityLetter = (id: string) =>
  apiFetch(`${BASE}/${encodeURIComponent(id)}/resend`, { method: 'POST', body: '{}' }).then((r) => (r.data as { request: LetterRequestView }).request);

/** POST /:id/cancel: withdraw it (for example, a wrong number), then fill the form again. */
export const cancelAuthorityLetter = (id: string) =>
  apiFetch(`${BASE}/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }).then((r) => (r.data as { request: LetterRequestView }).request);
