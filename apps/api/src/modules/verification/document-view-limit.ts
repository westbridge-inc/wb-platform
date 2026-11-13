/**
 * [FABLE-02 F3 · 13 Nov 2026] How many document view links ONE reviewer may mint in an hour
 * (GET /admin/verification/:id/document-url). The console asks for a link only when a reviewer opens a
 * paper, and a link lives five minutes, so a real review session stays well under it; a script walking the
 * queue to save every stored ID does not. Every view is still audited (VIEW_VERIFICATION_DOC).
 *
 * Keyed by the VERIFIED REVIEWER for the console's cookie session too, not by IP: the route's limiter is a
 * route-level onRequest hook, and Fastify runs it after the admin plugin's own onRequest `adminGuard`, which has
 * already adopted the HttpOnly cookie as the Bearer credential the limiter's key verifies (utils/rate-limit-key).
 * So reviewers sharing an office IP each have their own cap, and one reviewer's cap follows them to any network
 * (document-view-rate.test.ts proves both with cookie sessions).
 */
export const DOCUMENT_VIEW_LINKS_PER_HOUR = 120;
