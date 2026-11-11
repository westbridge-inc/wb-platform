-- [R1 · CARD-STAGING-TEST R2, 10 Nov 2026] A refund is PowerTranz's OWN transaction, with its own TransactionIdentifier
-- (TransactionType 5), and the original sale's record does not name it. When finance refunds a HELD card payment and
-- PowerTranz's approved answer carries that id, Swift keeps it beside the sale's, as it already does for a void
-- ("providerVoidRef") and for a refund to the card at closing (card_credit_refunds."providerRefundRef"), so finance
-- matches the portal's refund row. Only beside a confirmed refund (a NULL refund state refuses it too: the CHECK names
-- IS NOT NULL, as a NULL comparison would pass), at most 64 characters, and written once, like every other provider
-- reference on the row.
-- Additive: one nullable column, its CHECK and its write-once guard; no row changes.
--
-- ROLLBACK: rollback.sql beside this file — ONLY AFTER the code is rolled back (the new code reads the column).

SET lock_timeout = '10s';

ALTER TABLE "card_sessions" ADD COLUMN "providerRefundRef" TEXT;

ALTER TABLE "card_sessions" ADD CONSTRAINT "card_sessions_refund_ref_check"
  CHECK ("providerRefundRef" IS NULL OR ("providerRefundState" IS NOT NULL AND "providerRefundState" = 'REFUNDED' AND length("providerRefundRef") BETWEEN 1 AND 64));

CREATE OR REPLACE FUNCTION card_sessions_refund_ref_once() RETURNS trigger AS $$
BEGIN
  IF OLD."providerRefundRef" IS NOT NULL AND NEW."providerRefundRef" IS DISTINCT FROM OLD."providerRefundRef" THEN
    RAISE EXCEPTION 'card_sessions row %: the refund''s provider transaction reference is written once [R1]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER card_sessions_refund_ref_once BEFORE UPDATE OF "providerRefundRef" ON card_sessions
  FOR EACH ROW EXECUTE FUNCTION card_sessions_refund_ref_once();
