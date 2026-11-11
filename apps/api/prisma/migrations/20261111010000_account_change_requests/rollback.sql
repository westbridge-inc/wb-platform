-- [COMPANY-DOCS Part 3] Guarded rollback. A row is a store's request to change its business type or its account holder,
-- and the papers filed for it point at it; the table is dropped only when no change was ever asked. It forces row-level
-- security, so row security is switched off for this transaction: run this as a role that bypasses it.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "account_change_requests") THEN
    RAISE EXCEPTION 'ACCOUNT_CHANGES_IN_USE: a store asked for an account change; the record is kept, not rolled back';
  END IF;
END $$;
DROP TRIGGER IF EXISTS verification_documents_account_change_fixed ON "verification_documents";
DROP FUNCTION IF EXISTS verification_documents_account_change_fixed();
ALTER TABLE "verification_documents" DROP CONSTRAINT IF EXISTS "verification_documents_accountChangeId_fkey";
DROP INDEX IF EXISTS "verification_documents_accountChangeId_idx";
ALTER TABLE "verification_documents" DROP COLUMN IF EXISTS "accountChangeId";
DROP TABLE "account_change_requests";
DROP FUNCTION IF EXISTS account_change_requests_guard();
DROP TYPE IF EXISTS "BusinessTypeOption";
DROP TYPE IF EXISTS "AccountChangeStatus";
DROP TYPE IF EXISTS "AccountChangeKind";
COMMIT;
