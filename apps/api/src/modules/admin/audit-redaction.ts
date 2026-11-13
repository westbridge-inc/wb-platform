/**
 * [SEC-AUDIT 13 Nov 2026 · F9] Audit rows written before the document-approve route stopped recording them still
 * carry the insurer and policy number a reviewer typed (APPROVE_VERIFICATION_DOC changes.insurance). The table is
 * append-only, so they are dropped on the way OUT, for every reader that shows `changes`: an audit.read admin (or a
 * custody narrative) sees the reviewer's checks, never the policy, which stays on the document behind documents.review.
 */
const TYPED_INSURANCE_FIELDS = new Set(['insurerName', 'policyNumber']);

export function auditChangesForReaders(action: string, changes: unknown): unknown {
  if (action !== 'APPROVE_VERIFICATION_DOC' || !changes || typeof changes !== 'object' || Array.isArray(changes)) return changes;
  const insurance = (changes as Record<string, unknown>)['insurance'];
  if (!insurance || typeof insurance !== 'object' || Array.isArray(insurance)) return changes;
  const checks = Object.fromEntries(Object.entries(insurance).filter(([key]) => !TYPED_INSURANCE_FIELDS.has(key)));
  return { ...(changes as Record<string, unknown>), insurance: checks };
}
