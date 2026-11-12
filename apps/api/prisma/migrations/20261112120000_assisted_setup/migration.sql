-- [ASSISTED SETUP · owner 12 Nov 2026] A Swift admin sets a store up from the admin console (its papers, its menu, its
-- item photos) with the store's consent recorded first: who at the store agreed, how, when, and the consent words read to
-- them (assisted_setup_consents). Each thing done under it is one row (assisted_setup_actions), and a paper filed this way
-- names its uploader and the consent (verification_documents."assistedById", "assistedConsentId"). Additive: two new
-- tables, two nullable columns; no existing row changes.
--
-- ROLLBACK: rollback.sql beside this file (refused once any consent was recorded).

SET lock_timeout = '10s';

-- CreateEnum
CREATE TYPE "AssistedConsentChannel" AS ENUM ('IN_PERSON', 'PHONE', 'WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "AssistedActionKind" AS ENUM ('DOCUMENT', 'MENU_ITEM', 'ITEM_PHOTO');

-- AlterTable (nullable, no default: metadata-only)
ALTER TABLE "verification_documents" ADD COLUMN     "assistedById" TEXT,
ADD COLUMN     "assistedConsentId" TEXT;

-- CreateTable
CREATE TABLE "assisted_setup_consents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "agreedByName" TEXT NOT NULL,
    "agreedByRole" TEXT NOT NULL,
    "channel" "AssistedConsentChannel" NOT NULL,
    "agreedAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "consentDocumentType" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "recordedByAdminId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assisted_setup_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assisted_setup_actions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "kind" "AssistedActionKind" NOT NULL,
    "targetId" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assisted_setup_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assisted_setup_consents_tenantId_idx" ON "assisted_setup_consents"("tenantId");

-- CreateIndex
CREATE INDEX "assisted_setup_consents_vendorId_createdAt_idx" ON "assisted_setup_consents"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "assisted_setup_actions_tenantId_idx" ON "assisted_setup_actions"("tenantId");

-- CreateIndex
CREATE INDEX "assisted_setup_actions_vendorId_kind_targetId_idx" ON "assisted_setup_actions"("vendorId", "kind", "targetId");

-- CreateIndex
CREATE INDEX "assisted_setup_actions_consentId_idx" ON "assisted_setup_actions"("consentId");

-- CreateIndex
CREATE INDEX "verification_documents_assistedConsentId_idx" ON "verification_documents"("assistedConsentId");

-- AddForeignKey
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_assistedConsentId_fkey" FOREIGN KEY ("assistedConsentId") REFERENCES "assisted_setup_consents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assisted_setup_consents" ADD CONSTRAINT "assisted_setup_consents_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assisted_setup_actions" ADD CONSTRAINT "assisted_setup_actions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assisted_setup_actions" ADD CONSTRAINT "assisted_setup_actions_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "assisted_setup_consents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the store agreed to is typed in full: a name, a role, a reason; a reference is never an empty string.
ALTER TABLE "assisted_setup_consents"
  ADD CONSTRAINT "assisted_setup_consents_shape" CHECK (
    length(btrim("agreedByName")) > 0 AND length(btrim("agreedByRole")) > 0 AND length(btrim("reason")) > 0
    AND ("reference" IS NULL OR length(btrim("reference")) > 0));

-- A consent is written once, for the store's own tenant and its account holder at the time. It is never changed; it goes
-- only with its store (cascade) or with the account holder's erasure.
CREATE OR REPLACE FUNCTION assisted_setup_consents_guard() RETURNS trigger AS $$
DECLARE store_tenant TEXT; store_holder TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'assisted_setup_consents row %: a recorded consent is written once [ASSISTED SETUP]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."tenantId", vo."userId" INTO store_tenant, store_holder
    FROM vendors v JOIN vendor_owners vo ON vo.id = v."ownerId" WHERE v.id = NEW."vendorId";
  IF store_tenant IS NULL OR store_tenant <> NEW."tenantId" THEN
    RAISE EXCEPTION 'assisted_setup_consents: tenant % is not the store''s [STA-1 lineage]', NEW."tenantId" USING ERRCODE = 'check_violation';
  END IF;
  IF store_holder IS DISTINCT FROM NEW."holderId" THEN
    RAISE EXCEPTION 'assisted_setup_consents: the account holder named is not the store''s [ASSISTED SETUP]' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER assisted_setup_consents_guard BEFORE INSERT OR UPDATE ON "assisted_setup_consents"
  FOR EACH ROW EXECUTE FUNCTION assisted_setup_consents_guard();

-- An action is written once, for the store its consent was given for, in that consent's tenant.
CREATE OR REPLACE FUNCTION assisted_setup_actions_guard() RETURNS trigger AS $$
DECLARE consent_vendor TEXT; consent_tenant TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'assisted_setup_actions row %: an assisted action is written once [ASSISTED SETUP]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."vendorId", c."tenantId" INTO consent_vendor, consent_tenant FROM assisted_setup_consents c WHERE c.id = NEW."consentId";
  IF consent_vendor IS DISTINCT FROM NEW."vendorId" OR consent_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'assisted_setup_actions: the consent named was not given for this store [ASSISTED SETUP]' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER assisted_setup_actions_guard BEFORE INSERT OR UPDATE ON "assisted_setup_actions"
  FOR EACH ROW EXECUTE FUNCTION assisted_setup_actions_guard();

-- A paper is filed by Swift for the store, or not, when it is filed: never moved into or out of that later. (The consent
-- link may only be cleared, by the consent's own erasure: ON DELETE SET NULL.)
CREATE OR REPLACE FUNCTION verification_documents_assisted_fixed() RETURNS trigger AS $$
BEGIN
  IF NEW."assistedById" IS DISTINCT FROM OLD."assistedById"
     OR (NEW."assistedConsentId" IS DISTINCT FROM OLD."assistedConsentId" AND NEW."assistedConsentId" IS NOT NULL) THEN
    RAISE EXCEPTION 'verification_documents row %: who filed a paper is fixed [ASSISTED SETUP]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER verification_documents_assisted_fixed BEFORE UPDATE OF "assistedById", "assistedConsentId" ON "verification_documents"
  FOR EACH ROW EXECUTE FUNCTION verification_documents_assisted_fixed();

-- [ASSISTED SETUP] The account erasure deletes a closed account's consents (account-erasure-register:
-- AssistedSetupConsent.holderId CLEARED); the restore replay deletes them from a restored copy too
-- (deploy/restore-replay-erasures.sql), so each delete is captured in the erasure ledger like every other table the replay
-- deletes from. Dropped with the table on rollback.
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON "assisted_setup_consents" FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('holderId', 'id');

ALTER TABLE "assisted_setup_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assisted_setup_consents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "assisted_setup_consents";
CREATE POLICY "tenant_isolation" ON "assisted_setup_consents"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

ALTER TABLE "assisted_setup_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assisted_setup_actions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "assisted_setup_actions";
CREATE POLICY "tenant_isolation" ON "assisted_setup_actions"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
