-- Rollback for 20261114120000_kitchen_delivery_overflow. Run it while the new code is still serving, then roll the
-- code back.
--   0. Every branch's overflow back to NONE first (the console or the store's settings), or simply keep
--      DRAGONTAIL_INTEGRATION off (production ships with it off: then nothing ever read or wrote these columns).
--   1. Run this file.
--   2. Roll the code back.
-- orders."kitchenRoute*" are the record of where each such order went (ops and the store read them). They are dropped
-- only when NO order carries one; otherwise this file refuses and they stay (the previous release ignores them: they are
-- nullable).
-- [Sol] orders and vendor_integrations force row-level security: run as a role that bypasses it.
BEGIN;
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "kitchenRoute" IS NOT NULL) THEN
    RAISE EXCEPTION 'orders carry a kitchen route: keep the columns (the previous release ignores them)';
  END IF;
END $$;
ALTER TABLE "orders" DROP COLUMN IF EXISTS "kitchenRoute", DROP COLUMN IF EXISTS "kitchenRouteReason", DROP COLUMN IF EXISTS "kitchenRouteAt";
ALTER TABLE "vendor_integrations" DROP CONSTRAINT IF EXISTS "vendor_integrations_overflow_busy_hours_list";
ALTER TABLE "vendor_integrations" DROP COLUMN IF EXISTS "overflowMode", DROP COLUMN IF EXISTS "overflowBusyHours", DROP COLUMN IF EXISTS "overflowUpdatedAt",
  DROP COLUMN IF EXISTS "linkFailures", DROP COLUMN IF EXISTS "linkFirstFailureAt", DROP COLUMN IF EXISTS "linkOfflineAt", DROP COLUMN IF EXISTS "linkProbeAt";
DROP TYPE IF EXISTS "KitchenRoute";
DROP TYPE IF EXISTS "KitchenOverflowMode";
COMMIT;
