-- [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The in-app letter of authority: Swift writes a one-page letter for a
-- company's account (or a registered business's manager's), texts the director (or the owner) a single-use link, they
-- confirm a code texted to THEIR phone and sign with a finger; the signed PDF is filed as the account holder's letter of
-- authority document and a person at Swift still checks it. One new table; no existing row changes.
-- The signer's name and number are a third person's details (vendor/authority-letter: never logged, deleted with the
-- account, and an unsigned request is deleted 30 days after it ended).
--
-- ROLLBACK: rollback.sql beside this file.

SET lock_timeout = '10s';

CREATE TYPE "AuthorityLetterStatus" AS ENUM ('SENT', 'SIGNED', 'EXPIRED', 'CANCELLED');

CREATE TABLE "authority_letter_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "accountBasis" "VendorAccountBasis" NOT NULL,
    "businessName" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "requesterRole" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "signerPhone" TEXT NOT NULL,
    "letterText" TEXT NOT NULL,
    "letterSha256" TEXT NOT NULL,
    "status" "AuthorityLetterStatus" NOT NULL DEFAULT 'SENT',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sendCount" INTEGER NOT NULL DEFAULT 1,
    "lastSentAt" TIMESTAMP(3) NOT NULL,
    "openedAt" TIMESTAMP(3),
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "codeSends" INTEGER NOT NULL DEFAULT 0,
    "codeVerifiedAt" TIMESTAMP(3),
    "signingKeyHash" TEXT,
    "signingKeyExpiresAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signerIpHmac" TEXT,
    "signerUserAgent" TEXT,
    "signatureSha256" TEXT,
    "documentId" TEXT,
    "pdfFileKey" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "authority_letter_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "authority_letter_requests_tokenHash_key" ON "authority_letter_requests"("tokenHash");

CREATE INDEX "authority_letter_requests_userId_createdAt_idx" ON "authority_letter_requests"("userId", "createdAt");

CREATE INDEX "authority_letter_requests_status_expiresAt_idx" ON "authority_letter_requests"("status", "expiresAt");

ALTER TABLE "authority_letter_requests" ADD CONSTRAINT "authority_letter_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Shape: only the two letters; a secret is only ever kept as a 64-hex digest; a signed letter names its code check,
-- its signature, its filed document and its stored PDF.
ALTER TABLE "authority_letter_requests"
  ADD CONSTRAINT "authority_letter_requests_doc_type_check" CHECK ("docType" IN ('company_authority_letter', 'owner_authority_letter')),
  ADD CONSTRAINT "authority_letter_requests_basis_check" CHECK ("accountBasis" IN ('COMPANY', 'MANAGER')),
  ADD CONSTRAINT "authority_letter_requests_digests_check" CHECK (
    "tokenHash" ~ '^[0-9a-f]{64}$' AND "letterSha256" ~ '^[0-9a-f]{64}$'
    AND ("signingKeyHash" IS NULL OR "signingKeyHash" ~ '^[0-9a-f]{64}$')
    AND ("signatureSha256" IS NULL OR "signatureSha256" ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT "authority_letter_requests_signed_check" CHECK (
    ("status" = 'SIGNED') = ("signedAt" IS NOT NULL)
    AND ("status" <> 'SIGNED' OR ("codeVerifiedAt" IS NOT NULL AND "signatureSha256" IS NOT NULL AND "documentId" IS NOT NULL AND "pdfFileKey" IS NOT NULL)));

-- The words and the people they name are written once: what was signed is what was asked. A signed letter never changes
-- state again.
CREATE OR REPLACE FUNCTION authority_letter_requests_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId"
     OR NEW."docType" IS DISTINCT FROM OLD."docType" OR NEW."accountBasis" IS DISTINCT FROM OLD."accountBasis"
     OR NEW."businessName" IS DISTINCT FROM OLD."businessName" OR NEW."registrationNumber" IS DISTINCT FROM OLD."registrationNumber"
     OR NEW."requesterName" IS DISTINCT FROM OLD."requesterName" OR NEW."requesterRole" IS DISTINCT FROM OLD."requesterRole"
     OR NEW."signerName" IS DISTINCT FROM OLD."signerName" OR NEW."signerPhone" IS DISTINCT FROM OLD."signerPhone"
     OR NEW."letterText" IS DISTINCT FROM OLD."letterText" OR NEW."letterSha256" IS DISTINCT FROM OLD."letterSha256" THEN
    RAISE EXCEPTION 'authority_letter_requests: the letter and the people it names are written once [COMPANY-DOCS PART 2]' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'SIGNED' AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt"
     OR NEW."documentId" IS DISTINCT FROM OLD."documentId" OR NEW."pdfFileKey" IS DISTINCT FROM OLD."pdfFileKey"
     OR NEW."signatureSha256" IS DISTINCT FROM OLD."signatureSha256") THEN
    RAISE EXCEPTION 'authority_letter_requests: a signed letter is final [COMPANY-DOCS PART 2]' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authority_letter_requests_guard BEFORE UPDATE ON "authority_letter_requests"
  FOR EACH ROW EXECUTE FUNCTION authority_letter_requests_guard();

-- [Restore replays erasures] The account erasure deletes a closed account's requests (account.service): each deleted row
-- is captured in the off-site erasure ledger, so a restored backup deletes it again (deploy/restore-replay-erasures.sql).
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON "authority_letter_requests" FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
