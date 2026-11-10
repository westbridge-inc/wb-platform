-- [COMPANY-DOCS Part 3 · owner rulings 10 Nov 2026 ~07:3xZ (c) + (d)] A change to who a store account is, waiting for a
-- person at Swift: "Change business type" (BUSINESS_TYPE) or a company's account-holder handover (HOLDER_HANDOVER).
-- The stores keep selling on the papers they have while it waits; a paper filed for the change
-- (verification_documents."accountChangeId") counts for nothing until a person approves it, and then everything switches
-- in one transaction (modules/vendor/account-change.ts). Additive: one new table, one nullable column; no existing row
-- changes.
--
-- ROLLBACK: rollback.sql beside this file (refused once any change was asked).

SET lock_timeout = '10s';

-- CreateEnum
CREATE TYPE "AccountChangeKind" AS ENUM ('BUSINESS_TYPE', 'HOLDER_HANDOVER');

-- CreateEnum
CREATE TYPE "AccountChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REFUSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BusinessTypeOption" AS ENUM ('COMPANY', 'REGISTERED', 'MANAGER', 'OWN_NAME');

-- AlterTable (nullable, no default: metadata-only)
ALTER TABLE "verification_documents" ADD COLUMN     "accountChangeId" TEXT;

-- CreateTable
CREATE TABLE "account_change_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorOwnerId" TEXT NOT NULL,
    "kind" "AccountChangeKind" NOT NULL,
    "status" "AccountChangeStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "fromOption" "BusinessTypeOption",
    "toOption" "BusinessTypeOption",
    "holderId" TEXT,
    "newHolderId" TEXT,
    "newHolderAcceptedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_change_requests_tenantId_idx" ON "account_change_requests"("tenantId");

-- CreateIndex
CREATE INDEX "account_change_requests_vendorOwnerId_status_idx" ON "account_change_requests"("vendorOwnerId", "status");

-- CreateIndex
CREATE INDEX "account_change_requests_status_createdAt_idx" ON "account_change_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "account_change_requests_newHolderId_idx" ON "account_change_requests"("newHolderId");

-- CreateIndex
CREATE INDEX "verification_documents_accountChangeId_idx" ON "verification_documents"("accountChangeId");

-- AddForeignKey
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_accountChangeId_fkey" FOREIGN KEY ("accountChangeId") REFERENCES "account_change_requests"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_change_requests" ADD CONSTRAINT "account_change_requests_vendorOwnerId_fkey" FOREIGN KEY ("vendorOwnerId") REFERENCES "vendor_owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One change waiting per account, and one per person named as a new account holder.
CREATE UNIQUE INDEX "account_change_requests_one_pending_per_account"
  ON "account_change_requests"("vendorOwnerId") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "account_change_requests_one_pending_per_new_holder"
  ON "account_change_requests"("newHolderId") WHERE "status" = 'PENDING' AND "newHolderId" IS NOT NULL;

-- The shape of each kind, and of a decision.
ALTER TABLE "account_change_requests"
  ADD CONSTRAINT "account_change_requests_kind_shape" CHECK (
    ("kind" = 'BUSINESS_TYPE' AND "fromOption" IS NOT NULL AND "toOption" IS NOT NULL AND "fromOption" <> "toOption"
       AND "holderId" IS NULL AND "newHolderId" IS NULL AND "newHolderAcceptedAt" IS NULL)
    OR ("kind" = 'HOLDER_HANDOVER' AND "fromOption" IS NULL AND "toOption" IS NULL
       AND "holderId" IS NOT NULL AND "newHolderId" IS NOT NULL AND "holderId" <> "newHolderId")),
  -- Decided: when and by whom (the person at Swift; or, for WITHDRAWN, the holder who withdrew or the person named who
  -- said no). A person's approval or refusal always carries their reason.
  ADD CONSTRAINT "account_change_requests_decision_shape" CHECK (
    ("status" = 'PENDING') = ("decidedAt" IS NULL)
    AND ("status" = 'PENDING' OR "decidedById" IS NOT NULL)
    AND ("status" NOT IN ('APPROVED', 'REFUSED') OR "decisionReason" IS NOT NULL)),
  ADD CONSTRAINT "account_change_requests_handover_accepted_before_approval" CHECK (
    "kind" <> 'HOLDER_HANDOVER' OR "status" <> 'APPROVED' OR "newHolderAcceptedAt" IS NOT NULL);

-- What was asked is written once; a change is decided once (PENDING -> APPROVED | REFUSED | WITHDRAWN), and a decided
-- change never moves again. The account's tenant is the holder's, at the time of asking.
CREATE OR REPLACE FUNCTION account_change_requests_guard() RETURNS trigger AS $$
DECLARE holder_tenant TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'account_change_requests: a change is born PENDING [COMPANY-DOCS Part 3]' USING ERRCODE = 'check_violation';
    END IF;
    SELECT u."tenantId" INTO holder_tenant FROM vendor_owners vo JOIN users u ON u.id = vo."userId" WHERE vo.id = NEW."vendorOwnerId";
    IF holder_tenant IS NULL OR holder_tenant <> NEW."tenantId" THEN
      RAISE EXCEPTION 'account_change_requests: tenant % is not the account holder''s [STA-1 lineage]', NEW."tenantId" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."vendorOwnerId" IS DISTINCT FROM OLD."vendorOwnerId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
     OR NEW."fromOption" IS DISTINCT FROM OLD."fromOption"
     OR NEW."toOption" IS DISTINCT FROM OLD."toOption"
     OR NEW."holderId" IS DISTINCT FROM OLD."holderId"
     OR NEW."newHolderId" IS DISTINCT FROM OLD."newHolderId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'account_change_requests row %: what was asked is written once [COMPANY-DOCS Part 3]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'account_change_requests row %: a decided change is final (%)', OLD.id, OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."newHolderAcceptedAt" IS NOT NULL AND NEW."newHolderAcceptedAt" IS DISTINCT FROM OLD."newHolderAcceptedAt" THEN
    RAISE EXCEPTION 'account_change_requests row %: the named person''s yes is written once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER account_change_requests_guard BEFORE INSERT OR UPDATE ON "account_change_requests"
  FOR EACH ROW EXECUTE FUNCTION account_change_requests_guard();

-- A paper is filed for a change, or not, when it is filed: never moved into or out of one later.
CREATE OR REPLACE FUNCTION verification_documents_account_change_fixed() RETURNS trigger AS $$
BEGIN
  IF NEW."accountChangeId" IS DISTINCT FROM OLD."accountChangeId" THEN
    RAISE EXCEPTION 'verification_documents row %: the account change a paper was filed for is fixed [COMPANY-DOCS Part 3]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER verification_documents_account_change_fixed BEFORE UPDATE OF "accountChangeId" ON "verification_documents"
  FOR EACH ROW EXECUTE FUNCTION verification_documents_account_change_fixed();

ALTER TABLE "account_change_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_change_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "account_change_requests";
CREATE POLICY "tenant_isolation" ON "account_change_requests"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
