-- Rollback for 20261110160000_authority_letter_requests: the in-app letters of authority go (a letter already signed stays
-- filed as its document; only the request and its signing evidence are lost). Deploy the code that no longer reads the
-- table first.
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON "authority_letter_requests";
DROP TRIGGER IF EXISTS authority_letter_requests_guard ON "authority_letter_requests";
DROP FUNCTION IF EXISTS authority_letter_requests_guard();
DROP TABLE IF EXISTS "authority_letter_requests";
DROP TYPE IF EXISTS "AuthorityLetterStatus";
