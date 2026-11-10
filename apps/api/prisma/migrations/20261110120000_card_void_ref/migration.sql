-- [CARD-STAGING-TEST 10 Nov 2026] A void Swift sends is PowerTranz's OWN transaction, with its own
-- TransactionIdentifier (TransactionType 4), and the original sale's record does not name it. When PowerTranz's
-- approved answer to the void carries that id, Swift keeps it beside the sale's, so finance can match the void row in
-- the Merchant Portal and the settlement report. Only beside a confirmed void (a NULL void state refuses it too: the
-- CHECK names IS NOT NULL, as a NULL comparison would pass), at most 64 characters.
-- Additive: one nullable column and its CHECK; no row changes.
--
-- ROLLBACK: rollback.sql beside this file.

SET lock_timeout = '10s';

ALTER TABLE "card_sessions" ADD COLUMN "providerVoidRef" TEXT;

ALTER TABLE "card_sessions" ADD CONSTRAINT "card_sessions_void_ref_check"
  CHECK ("providerVoidRef" IS NULL OR ("providerVoidState" IS NOT NULL AND "providerVoidState" = 'VOIDED' AND length("providerVoidRef") BETWEEN 1 AND 64));
