-- [OWNER RULING 13 Nov 2026 · REVIEW-2502-B S3-1] A late MMG weekly-fee payment the owner credited alone, and the
-- second person's review of it. Its own table: the credit writes it in its commit and the review writes it once; no
-- money path (finance's resolution of the confirmation, a re-check, a reversal) writes it, so nothing that settles the
-- payment can erase the review it still owes. Additive: one new table, no existing row changes.
SET lock_timeout = '10s';

-- CreateTable
CREATE TABLE "mmg_late_credit_reviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "creditedBy" TEXT NOT NULL,
    "creditedAt" TIMESTAMP(3) NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mmg_late_credit_reviews_pkey" PRIMARY KEY ("id"),
    -- A review is whole or absent: who, when and what they found, together; and only these two findings.
    CONSTRAINT "mmg_late_credit_reviews_review_whole" CHECK (
      ("reviewedBy" IS NULL AND "reviewedAt" IS NULL AND "outcome" IS NULL AND "note" IS NULL)
      OR ("reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "outcome" IN ('AGREED', 'DISPUTED') AND "note" IS NOT NULL)),
    -- The second person is never the one who credited it (the service also refuses every account linked to them).
    CONSTRAINT "mmg_late_credit_reviews_second_person" CHECK ("reviewedBy" IS NULL OR "reviewedBy" <> "creditedBy")
);

-- CreateIndex
CREATE UNIQUE INDEX "mmg_late_credit_reviews_checkoutId_key" ON "mmg_late_credit_reviews"("checkoutId");

-- CreateIndex
CREATE INDEX "mmg_late_credit_reviews_tenantId_idx" ON "mmg_late_credit_reviews"("tenantId");

-- CreateIndex
CREATE INDEX "mmg_late_credit_reviews_tenantId_reviewedAt_idx" ON "mmg_late_credit_reviews"("tenantId", "reviewedAt");

-- AddForeignKey
ALTER TABLE "mmg_late_credit_reviews" ADD CONSTRAINT "mmg_late_credit_reviews_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "mmg_checkout_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A review is recorded once: the credit's facts never change, and a recorded review is never rewritten or removed
-- by an update.
CREATE OR REPLACE FUNCTION mmg_late_credit_reviews_write_once() RETURNS trigger AS $$
  BEGIN
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."checkoutId" IS DISTINCT FROM OLD."checkoutId"
      OR NEW."creditedBy" IS DISTINCT FROM OLD."creditedBy" OR NEW."creditedAt" IS DISTINCT FROM OLD."creditedAt" THEN
      RAISE EXCEPTION 'mmg_late_credit_reviews row %: the credit it records cannot change', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."reviewedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'mmg_late_credit_reviews row %: its review is already recorded', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mmg_late_credit_reviews_write_once ON "mmg_late_credit_reviews";
CREATE TRIGGER mmg_late_credit_reviews_write_once BEFORE UPDATE ON "mmg_late_credit_reviews"
  FOR EACH ROW EXECUTE FUNCTION mmg_late_credit_reviews_write_once();

-- [W-201] Tenant isolation, the canonical predicate (rlsDdlFor).
ALTER TABLE "mmg_late_credit_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mmg_late_credit_reviews" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mmg_late_credit_reviews";
CREATE POLICY "tenant_isolation" ON "mmg_late_credit_reviews"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
