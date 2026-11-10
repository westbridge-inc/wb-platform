-- Rollback of 20261110120000_card_void_ref: drops the void's own transaction reference (nothing else depends on it).
ALTER TABLE "card_sessions" DROP CONSTRAINT IF EXISTS "card_sessions_void_ref_check";
ALTER TABLE "card_sessions" DROP COLUMN IF EXISTS "providerVoidRef";
