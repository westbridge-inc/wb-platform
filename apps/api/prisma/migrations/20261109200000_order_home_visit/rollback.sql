-- [OWNER-ASKS · review R1] Guarded rollback of the home-visit marker. Refused while any live appointment (PENDING or
-- ACCEPTED) is or may be a home visit: its marker cannot be rebuilt (a 0-km visit). Removes its own migration-history
-- row, so a later deploy adds the column again. Row security off for the check (orders FORCE it).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "fulfillment" = 'APPOINTMENT' AND "status" IN ('PENDING', 'ACCEPTED') AND "homeVisit" IS DISTINCT FROM false) THEN
    RAISE EXCEPTION 'order_home_visit rollback refused: live home visits exist';
  END IF;
END $$;
ALTER TABLE "orders" DROP COLUMN IF EXISTS "homeVisit";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261109200000_order_home_visit';
COMMIT;
