/**
 * [FABLE-02 F3 · 13 Nov 2026] How many document view links ONE reviewer may mint in an hour
 * (GET /admin/verification/:id/document-url). The console asks for a link only when a reviewer opens a
 * paper, and a link lives five minutes, so a real review session stays well under it; a script walking the
 * queue to save every stored ID does not. Keyed by the verified caller (the global limiter's key), so one
 * reviewer's run never blocks another. Every view is still audited (VIEW_VERIFICATION_DOC).
 */
export const DOCUMENT_VIEW_LINKS_PER_HOUR = 120;
