-- [CARD-READY] Guarded rollback. A row is a refund of a partner's card money that a person asked for;
-- the table is dropped only when it has never held one. It forces row-level security, so row
-- security is switched off for this transaction: run this as a role that bypasses it.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "card_credit_refunds") THEN
    RAISE EXCEPTION 'CARD_CREDIT_REFUNDS_IN_USE: a refund to a card was asked; the record is kept, not rolled back';
  END IF;
END $$;
DROP TABLE "card_credit_refunds";
DROP FUNCTION IF EXISTS card_credit_refunds_guard();
COMMIT;
