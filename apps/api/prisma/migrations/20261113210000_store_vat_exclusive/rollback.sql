-- Rollback for 20261113210000_store_vat_exclusive. RUN THIS WHILE THE NEW CODE IS STILL SERVING, then roll the code back.
-- [REVIEW-A F2 · REVIEW-B S3-3] The order (README.md beside this file is the runbook):
--   1. CLOSE every store on "prices before VAT" (PRICES_EXCLUDE_VAT): its open-now switch off.
--   2. Let its orders finish: no order with "vatOnTop" may still be open (this file refuses while one is).
--   3. Run this file (new code still live): each such store goes back to PENDING on "My prices do not include VAT"
--      (ADD_VAT_AT_CHECKOUT, the previous release's meaning of prices before VAT), so nothing is added to its prices
--      until a person approves it again; a waiting request for the basis is cleared.
--   4. Only then roll the CODE back. (Rolling the code back first breaks every read of such a store: the previous
--      Prisma client cannot read a row carrying PRICES_EXCLUDE_VAT. And an open on-top order under the previous code
--      would tell its rider to pay the store the goods WITHOUT the VAT the rider collected.)
-- NOTHING IS DROPPED. orders."vatOnTop" is the only record of each placed order's VAT basis (its VAT was ADDED, its
-- vatBase excludes it): dropping it would make the previous release read those orders as VAT-inclusive (wrong VAT
-- report, wrong receipts), and a later roll-forward would re-add it as false for good. The previous release ignores the
-- column (NOT NULL DEFAULT false is safe for its inserts) and order_items."substituteVatClass" (nullable). The enum value
-- stays too (Postgres cannot drop one; no store row uses it after this). The migration stays recorded as applied, so a
-- roll-forward does not re-run it.
-- KNOWN LIMIT after the code rollback: the previous release's VAT report treats every VAT order as VAT-inclusive, so its
-- report for a period that holds on-top orders understates line 17 by their VAT. Use the new release's report (or that
-- period's export: tax + vat_basis) for such periods.
-- [Sol] orders and vendors force row-level security: row security is off for this transaction, so a role that does not
-- bypass it is refused with an error instead of finding the tables "empty". Run as a role that bypasses it.
BEGIN;
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "orders"
     WHERE "vatOnTop" = true
       AND "status" NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'RETURNED')
  ) THEN
    RAISE EXCEPTION 'store VAT rollback refused: an order whose VAT is added on top is still open. Close the stores pricing before VAT and let their orders finish first (README.md).';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "vendors"
     WHERE "vatMode" = 'PRICES_EXCLUDE_VAT' AND "vatStatus" = 'APPROVED' AND "isCurrentlyOpen" = true AND "acceptingOrders" = true
  ) THEN
    RAISE EXCEPTION 'store VAT rollback refused: a store pricing before VAT is still open. Close it first: after this it would sell at its typed prices with no VAT (README.md).';
  END IF;
END $$;
UPDATE "vendors" SET "vatStatus" = 'PENDING', "vatMode" = 'ADD_VAT_AT_CHECKOUT',
  "vatApprovedNumber" = NULL, "vatApprovedName" = NULL, "vatEffectiveFrom" = NULL,
  "vatReviewedBy" = NULL, "vatReviewedAt" = NULL, "vatModeRequested" = NULL
 WHERE "vatMode" = 'PRICES_EXCLUDE_VAT' AND "vatStatus" IN ('PENDING', 'APPROVED');
UPDATE "vendors" SET "vatMode" = 'ADD_VAT_AT_CHECKOUT' WHERE "vatMode" = 'PRICES_EXCLUDE_VAT';
UPDATE "vendors" SET "vatModeRequested" = NULL WHERE "vatModeRequested" = 'PRICES_EXCLUDE_VAT';
COMMIT;
