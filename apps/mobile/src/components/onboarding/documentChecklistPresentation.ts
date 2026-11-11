export function emptyChecklistCopy(status: { categoryUnavailable?: boolean }): { title: string; body: string } {
  if (status.categoryUnavailable) {
    return {
      title: 'Service checks pending',
      body: 'This service is unavailable while its required checks are prepared. You cannot receive requests yet.',
    };
  }
  return {
    title: 'Verification steps unavailable',
    body: 'We cannot confirm your requirements right now. Try again later.',
  };
}

/**
 * [Legal research G4, in-app ¶17 · owner 15 Oct 2026] What the documents screen says happens to the documents:
 * a person checks them (identity checks are human-only; face-matching is off), and the daily expiry sweep
 * (jobs/queue.ts 'expiry-sweep', 06:00 daily) re-checks their dates.
 */
export const DOCUMENT_REVIEW_PROMISE = 'A person on our team checks your documents and re-checks expiry dates daily.';

/**
 * [Owner, 1 Oct · truth] The documents the server compares with the profile
 * selfie right now — GET /verification/status's `faceMatchDocTypes`. Empty
 * while face-matching is off. Kept as the reading of the server's contract; since the legal research (G4)
 * no screen claims a face was matched, whatever this returns. Anything that is not a list of document
 * types names none.
 */
export function faceMatchedDocTypes(status: { faceMatchDocTypes?: unknown } | null | undefined): ReadonlySet<string> {
  const named = status?.faceMatchDocTypes;
  if (!Array.isArray(named)) return new Set();
  return new Set(named.filter((docType): docType is string => typeof docType === 'string' && docType.length > 0));
}

/**
 * [REPLACE-PENDING · owner request 8 Oct 2026] What a document waiting for review says: it can be replaced
 * (the person sent the wrong one), and once replaced it says so. The server marks a copy that replaced an
 * earlier waiting one (`replaced` on GET /verification/status documents).
 */
export function pendingDocumentLabel(replaced: boolean, submittedAt?: string | null): string {
  if (replaced) return 'Replaced — waiting for review · tap to replace again';
  const on = submittedAt ? new Date(submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;
  return on ? `Submitted ${on} — in review · tap to replace` : 'In review · tap to replace';
}

/**
 * [VERIFY-DOCS · owner rulings 6 Oct 2026] The documents the server says this person MAY add —
 * GET /verification/status's `optional` ([ROLE-DOCS · owner 21 Oct 2026] a police clearance for a
 * taxi driver; no mover is offered a second ID any more). Never required, never in the progress count. Only the server's own list, only
 * strings, and never a type the required checklist already shows.
 */
export function optionalDocTypes(status: { optional?: unknown; checklist?: unknown } | null | undefined): string[] {
  const named = status?.optional;
  if (!Array.isArray(named)) return [];
  const required = new Set(Array.isArray(status?.checklist) ? status!.checklist as unknown[] : []);
  const seen = new Set<string>();
  return named.filter((docType): docType is string => {
    if (typeof docType !== 'string' || docType.length === 0 || required.has(docType) || seen.has(docType)) return false;
    seen.add(docType);
    return true;
  });
}

/** What an optional document is for, in the person's words. */
export function optionalDocHint(docType: string): string {
  // [VERIFY-DOCS] Say what really happens: no screen shows a Police-cleared badge yet, so promise none.
  if (docType === 'police_clearance') return 'Optional. If Swift approves a current one, your account is recorded as police-cleared.';
  return 'Optional. Not needed to start working.';
}

type ChecklistDoc = { docType?: unknown; status?: unknown; createdAt?: unknown; expiresAt?: unknown };

/** The document that speaks for a checklist step. Precedence: an in-flight renewal shows as pending; else the
 *  current approved document (with its expiry); else the newest row (expired/rejected), which re-opens the upload. */
export function latestChecklistDoc<D extends ChecklistDoc>(documents: readonly D[], docType: string, now = Date.now()): D | undefined {
  const docs = documents
    .filter((d) => d.docType === docType)
    .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
  return (
    docs.find((d) => d.status === 'PENDING')
    ?? docs.find((d) => d.status === 'APPROVED' && (!d.expiresAt || new Date(String(d.expiresAt)).getTime() > now))
    ?? docs[0]
  );
}

/** How far through the required steps a person is (optional documents never count). `inReview`: every step is
 *  sent and at least one waits for a person on our team: nothing more for them to do but wait. */
export function checklistProgress(status: { checklist?: unknown; documents?: unknown } | null | undefined, now = Date.now()) {
  const checklist = Array.isArray(status?.checklist) ? (status!.checklist as unknown[]).filter((d): d is string => typeof d === 'string') : [];
  const documents = Array.isArray(status?.documents) ? (status!.documents as ChecklistDoc[]) : [];
  const stateOf = (docType: string) => latestChecklistDoc(documents, docType, now)?.status;
  const approved = checklist.filter((dt) => stateOf(dt) === 'APPROVED').length;
  const allSubmitted = checklist.length > 0 && checklist.every((dt) => stateOf(dt) === 'APPROVED' || stateOf(dt) === 'PENDING');
  return { total: checklist.length, approved, allSubmitted, inReview: allSubmitted && approved < checklist.length };
}

/** [FOLLOWUPS 11 Nov 2026] A rider or driver whose papers are all sent and wait for approval opens the app on a plain
 *  status, never on a sign-up pitch with the answer buried in the list below it. */
export const MOVER_IN_REVIEW = {
  title: 'Your documents are in review',
  body: 'You have sent everything. A person on our team checks them Monday to Saturday, 8:00–16:00 Guyana time. You can go online once they are approved, and this screen changes by itself then.',
} as const;

