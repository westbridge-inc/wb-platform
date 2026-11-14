-- ROLLBACK for 20261111120000_kitchen_integration. Roll the application back first (or keep DRAGONTAIL_INTEGRATION off).
-- Refuses while any order sync exists: the record of which orders went to a kitchen system would be lost.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "order_integration_syncs") THEN
    RAISE EXCEPTION 'refusing rollback: order syncs exist';
  END IF;
END $$;
DROP TABLE "order_integration_syncs";
DROP TABLE "kitchen_order_counters";
DROP TABLE "vendor_integrations";
DROP FUNCTION IF EXISTS order_integration_syncs_tenant_matches_order();
DROP FUNCTION IF EXISTS vendor_integrations_tenant_matches_vendor();
DROP FUNCTION IF EXISTS vendor_integrations_identity_frozen();
ALTER TABLE "options" DROP COLUMN "externalItemNo";
ALTER TABLE "items" DROP COLUMN "externalItemNo";
DROP TYPE "KitchenSyncState";
DROP TYPE "KitchenProvider";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261111120000_kitchen_integration';
COMMIT;
