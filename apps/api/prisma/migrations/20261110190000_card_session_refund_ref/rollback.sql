-- Rollback of 20261110190000_card_session_refund_ref: drops the HELD refund's own transaction reference and its guards.
-- Run ONLY AFTER the code is rolled back: the new code reads "providerRefundRef" (Prisma's default selects, the admin
-- card-session views, the data export, the money-reference census), so dropping it under the new code breaks every
-- card-session read.
DROP TRIGGER IF EXISTS card_sessions_refund_ref_once ON card_sessions;
DROP FUNCTION IF EXISTS card_sessions_refund_ref_once();
ALTER TABLE "card_sessions" DROP CONSTRAINT IF EXISTS "card_sessions_refund_ref_check";
ALTER TABLE "card_sessions" DROP COLUMN IF EXISTS "providerRefundRef";
