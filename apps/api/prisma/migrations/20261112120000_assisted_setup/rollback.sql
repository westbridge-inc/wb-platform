-- [ASSISTED SETUP] Guarded rollback. A row is a store's recorded consent for Swift to set it up, and the papers filed
-- under it point at it; the tables are dropped only when no consent was ever recorded. They force row-level security, so
-- row security is switched off for this transaction: run this as a role that bypasses it.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "assisted_setup_consents") THEN
    RAISE EXCEPTION 'ASSISTED_SETUP_IN_USE: a store''s consent for assisted setup is on record; the record is kept, not rolled back';
  END IF;
END $$;
DROP TRIGGER IF EXISTS verification_documents_assisted_fixed ON "verification_documents";
DROP FUNCTION IF EXISTS verification_documents_assisted_fixed();
ALTER TABLE "verification_documents" DROP CONSTRAINT IF EXISTS "verification_documents_assistedConsentId_fkey";
DROP INDEX IF EXISTS "verification_documents_assistedConsentId_idx";
ALTER TABLE "verification_documents" DROP COLUMN IF EXISTS "assistedConsentId";
ALTER TABLE "verification_documents" DROP COLUMN IF EXISTS "assistedById";
DROP TABLE "assisted_setup_actions";
DROP TABLE "assisted_setup_consents";
DROP FUNCTION IF EXISTS assisted_setup_actions_guard();
DROP FUNCTION IF EXISTS assisted_setup_consents_guard();
DROP TYPE IF EXISTS "AssistedActionKind";
DROP TYPE IF EXISTS "AssistedAgreedAs";
DROP TYPE IF EXISTS "AssistedConsentChannel";
COMMIT;
