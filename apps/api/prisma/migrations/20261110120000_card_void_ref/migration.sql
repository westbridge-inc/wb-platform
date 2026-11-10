-- [CARD-STAGING-TEST 10 Nov 2026] A void Swift sends is PowerTranz's OWN transaction, with its own
-- TransactionIdentifier (TransactionType 4), and the original sale's record does not name it. When PowerTranz's
-- approved answer to the void carries that id, Swift keeps it beside the sale's, so finance can match the void row in
-- the Merchant Portal and the settlement report. Only beside a confirmed void (a NULL void state refuses it too: the
-- CHECK names IS NOT NULL, as a NULL comparison would pass), at most 64 characters, and written once, like every
-- other provider reference on the row [REVIEW-2466-B F6].
-- Additive: one nullable column, its CHECK and its write-once guard; no row changes.
--
-- ROLLBACK: rollback.sql beside this file — ONLY AFTER the code is rolled back (the new code reads the column).

SET lock_timeout = '10s';

ALTER TABLE "card_sessions" ADD COLUMN "providerVoidRef" TEXT;

ALTER TABLE "card_sessions" ADD CONSTRAINT "card_sessions_void_ref_check"
  CHECK ("providerVoidRef" IS NULL OR ("providerVoidState" IS NOT NULL AND "providerVoidState" = 'VOIDED' AND length("providerVoidRef") BETWEEN 1 AND 64));

CREATE OR REPLACE FUNCTION card_sessions_void_ref_once() RETURNS trigger AS $$
BEGIN
  IF OLD."providerVoidRef" IS NOT NULL AND NEW."providerVoidRef" IS DISTINCT FROM OLD."providerVoidRef" THEN
    RAISE EXCEPTION 'card_sessions row %: the void''s provider transaction reference is written once [CARD-STAGING-TEST]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER card_sessions_void_ref_once BEFORE UPDATE OF "providerVoidRef" ON card_sessions
  FOR EACH ROW EXECUTE FUNCTION card_sessions_void_ref_once();
