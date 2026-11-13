-- Rollback for 20261113210000_store_vat_exclusive. Roll the CODE back first.
-- The previous release does not know PRICES_EXCLUDE_VAT (its client cannot read a store row carrying it), so every such
-- store goes back to PENDING on "My prices do not include VAT" (ADD_VAT_AT_CHECKOUT, the previous release's meaning of
-- prices before VAT): nothing is added to its prices until a person approves it again. CLOSE those stores first (or
-- withdraw their VAT) so no order is taken at prices without their VAT. Orders already placed keep their totals and VAT
-- (taxAmount stays as frozen). The enum value itself stays (Postgres cannot drop one; no row uses it after this).
BEGIN;
SET LOCAL lock_timeout = '10s';
UPDATE "vendors" SET "vatStatus" = 'PENDING', "vatMode" = 'ADD_VAT_AT_CHECKOUT',
  "vatApprovedNumber" = NULL, "vatApprovedName" = NULL, "vatEffectiveFrom" = NULL,
  "vatReviewedBy" = NULL, "vatReviewedAt" = NULL, "vatModeRequested" = NULL
 WHERE "vatMode" = 'PRICES_EXCLUDE_VAT' AND "vatStatus" IN ('PENDING', 'APPROVED');
UPDATE "vendors" SET "vatMode" = 'ADD_VAT_AT_CHECKOUT' WHERE "vatMode" = 'PRICES_EXCLUDE_VAT';
UPDATE "vendors" SET "vatModeRequested" = NULL WHERE "vatModeRequested" = 'PRICES_EXCLUDE_VAT';
ALTER TABLE "orders" DROP COLUMN IF EXISTS "vatOnTop";
COMMIT;
