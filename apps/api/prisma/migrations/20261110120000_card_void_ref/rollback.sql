-- Rollback of 20261110120000_card_void_ref: drops the void's own transaction reference and its guards.
-- Run ONLY AFTER the code is rolled back: the new code reads "providerVoidRef" (Prisma's default selects, the admin
-- card-session views, the data export, the money-reference census), so dropping it under the new code breaks every
-- card-session read.
DROP TRIGGER IF EXISTS card_sessions_void_ref_once ON card_sessions;
DROP FUNCTION IF EXISTS card_sessions_void_ref_once();
ALTER TABLE "card_sessions" DROP CONSTRAINT IF EXISTS "card_sessions_void_ref_check";
ALTER TABLE "card_sessions" DROP COLUMN IF EXISTS "providerVoidRef";
